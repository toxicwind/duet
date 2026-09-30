// duet cell daemon — watches ~/workspace/skills/, pushes to yote.
// Event-driven (fs.watch), batched transfers, failover queue.
// Usage: bun src/cell.ts [--once]

import { HashCache } from "./hasher";
import { DebouncedWatcher } from "./watcher";
import { FailoverQueue } from "./queue";
import { buildManifest, planSync, defaultIgnore, type Manifest } from "./sync";
import { yoteExec, pushBatch, pullBatch, fetchManifest } from "./transport";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const CELL_ROOT = `${process.env.HOME}/workspace/skills`;
const YOTE_ROOT = "/home/toxic/sovereign/skills";
const STATE_DIR = `${process.env.HOME}/.duet`;
const BASELINE_PATH = join(STATE_DIR, "baseline.json");
const QUEUE_PATH = join(STATE_DIR, "queue.jsonl");
const CACHE_PATH = join(STATE_DIR, "hashcache.json");
const QUARANTINE_PATH = join(STATE_DIR, "quarantine.jsonl");
const SCRATCH_DIR = join(STATE_DIR, "scratch");
const MANIFEST_INTERVAL_MS = 10000; // poll yote manifest (cell can't receive push)
const MAX_ATTEMPTS = 20; // then quarantine — a batch that can't succeed must never spin forever
const STALE_MS = 30 * 60 * 1000; // scratch older than this gets swept

function loadBaseline(): Manifest {
  try {
    if (existsSync(BASELINE_PATH)) {
      return JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function saveBaseline(m: Manifest) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = BASELINE_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(m));
    require("fs").renameSync(tmp, BASELINE_PATH);
  } catch {}
}

// Watchdog: sweep stale duet scratch so no retry loop can ever fill a disk
// again. Covers the cell staging dir, legacy /tmp junk from the pre-scratch
// build, atomic-write leftovers in the skills tree, and yote-side staging.
// Runs at boot and every 5 minutes. (Chris 2026-09-30: the /tmp fill broke all.)
async function sweepStaleScratch(reason: string) {
  const now = Date.now();
  let removed = 0;
  const rmOld = (dir: string, pattern: RegExp) => {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (!pattern.test(e)) continue;
      const p = join(dir, e);
      try {
        if (now - statSync(p).mtimeMs > STALE_MS) { rmSync(p, { recursive: true, force: true }); removed++; }
      } catch { /* best effort */ }
    }
  };
  rmOld(SCRATCH_DIR, /^duet-(push|pull|extract)-/);
  rmOld(tmpdir(), /^duet-(push|pull|extract)-/); // legacy: the old build leaked these into /tmp
  // atomic-write leftovers (*.duet-tmp-<pid>) orphaned by killed daemons
  const walkLeftovers = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walkLeftovers(p); continue; }
      if (n.includes(".duet-tmp-") && now - st.mtimeMs > STALE_MS) {
        try { rmSync(p, { force: true }); removed++; } catch { /* best effort */ }
      }
    }
  };
  walkLeftovers(CELL_ROOT);
  // yote side — never touches the manifest
  try {
    await yoteExec(`find /home/toxic/.duet-scratch -maxdepth 1 \\( -name 'duet-pull-*' -o -name 'duet-push-*' -o -name 'duet-*-chunk-*' -o -name 'duet-*.tar.gz' \\) -mmin +30 -delete`);
  } catch { /* bridge may be down; local sweep already done */ }
  if (removed > 0 || reason === "boot") console.log(`[duet-cell] scratch sweep (${reason}): removed ${removed} stale entries`);
}

async function main() {
  const once = process.argv.includes("--once");
  mkdirSync(STATE_DIR, { recursive: true });
  await sweepStaleScratch("boot");

  const hasher = new HashCache(CACHE_PATH);
  const queue = new FailoverQueue(QUEUE_PATH);
  let baseline = loadBaseline();

  console.log(`[duet-cell] root=${CELL_ROOT} yote=${YOTE_ROOT}`);

  // --- Drain failover queue first ---
  async function drainQueue(): Promise<boolean> {
    queue.coalesce();
    let batch = queue.peek();
    while (batch) {
      if (batch.attempts >= MAX_ATTEMPTS) {
        // Poisoned batch: it will never succeed (files deleted on the far
        // side, permanent transport mismatch, ...). Quarantine it LOUDLY and
        // move on — never spin forever, never block the rest of the queue.
        try {
          appendFileSync(QUARANTINE_PATH, JSON.stringify({ ...batch, quarantinedAt: Date.now(), reason: `failed ${batch.attempts} attempts` }) + "\n");
        } catch { /* best effort */ }
        console.log(`[duet-cell] QUARANTINED ${batch.direction} batch ${batch.id} after ${batch.attempts} attempts (${batch.paths.length} files) — see quarantine.jsonl`);
        queue.ack(batch.id);
        batch = queue.peek();
        continue;
      }
      console.log(`[duet-cell] draining ${batch.direction} batch ${batch.id} (${batch.paths.length} files, attempt ${batch.attempts})`);
      let ok = false;
      if (batch.direction === "push") {
        ok = await pushBatch(CELL_ROOT, YOTE_ROOT, batch.paths);
      } else {
        const data = await pullBatch(YOTE_ROOT, batch.paths);
        if (data) {
          for (const [rel, content] of data) {
            const dest = join(CELL_ROOT, rel);
            mkdirSync(join(dest, ".."), { recursive: true });
            // Atomic write: tmp + rename (synx pattern)
            const tmp = dest + `.duet-tmp-${process.pid}`;
            writeFileSync(tmp, content);
            require("fs").renameSync(tmp, dest);
            hasher.invalidate(rel);
          }
          ok = true;
        }
      }
      if (ok) {
        queue.ack(batch.id);
        console.log(`[duet-cell] batch ${batch.id} OK`);
      } else {
        queue.bump(batch.id);
        const next = queue.peek() === batch ? "now" : `in backoff`;
        console.log(`[duet-cell] batch ${batch.id} FAILED (attempt ${batch.attempts}), retry ${next}`);
        return false; // stop draining, bridge is down or batch is poisoned
      }
      batch = queue.peek();
    }
    return true;
  }

  // --- Reconcile with yote ---
  async function reconcile(): Promise<void> {
    // 1. Drain queue
    const drained = await drainQueue();
    if (!drained) return; // bridge down, skip reconcile

    // 2. Fetch yote manifest
    const remote = await fetchManifest(YOTE_ROOT);
    if (!remote) {
      console.log("[duet-cell] no yote manifest (yote daemon not running?), skipping pull");
      return;
    }

    // 3. Build local manifest
    const local = buildManifest(CELL_ROOT, hasher, defaultIgnore);
    hasher.save();

    // 4. Plan
    const plan = planSync(local, remote, baseline);

    if (plan.conflicts.length > 0) {
      console.log(`[duet-cell] CONFLICTS (mtime tie, manual review): ${plan.conflicts.join(", ")}`);
    }

    // 5. Execute
    if (plan.push.length > 0) {
      console.log(`[duet-cell] pushing ${plan.push.length} files`);
      const ok = await pushBatch(CELL_ROOT, YOTE_ROOT, plan.push);
      if (!ok) {
        queue.enqueue("push", plan.push);
        console.log("[duet-cell] push failed, queued for retry");
      }
    }
    if (plan.pull.length > 0) {
      console.log(`[duet-cell] pulling ${plan.pull.length} files`);
      const data = await pullBatch(YOTE_ROOT, plan.pull);
      if (data) {
        for (const [rel, content] of data) {
          const dest = join(CELL_ROOT, rel);
          mkdirSync(join(dest, ".."), { recursive: true });
          const tmp = dest + `.duet-tmp-${process.pid}`;
          writeFileSync(tmp, content);
          require("fs").renameSync(tmp, dest);
          hasher.invalidate(rel);
        }
      } else {
        queue.enqueue("pull", plan.pull);
        console.log("[duet-cell] pull failed, queued for retry");
      }
    }

    // 6. Update baseline to converged state
    const converged: Manifest = {};
    const fresh = buildManifest(CELL_ROOT, hasher, defaultIgnore);
    const remoteFresh = await fetchManifest(YOTE_ROOT);
    if (remoteFresh) {
      for (const [p, h] of Object.entries(fresh)) {
        const rh = (remoteFresh as Manifest)[p];
        if (rh && rh.hash === h.hash) converged[p] = h;
      }
      baseline = converged;
      saveBaseline(baseline);
    }
    hasher.save();
  }

  // Initial reconcile
  await reconcile();
  if (once) {
    console.log("[duet-cell] --once done");
    process.exit(0);
  }

  // --- Event-driven local watcher ---
  const watcher = new DebouncedWatcher(
    CELL_ROOT,
    async (events) => {
      const paths = events.map(e => e.path);
      console.log(`[duet-cell] local change: ${paths.length} files`);
      // Invalidate cache for changed paths
      for (const p of paths) hasher.invalidate(p);
      // Push immediately (batched)
      const ok = await pushBatch(CELL_ROOT, YOTE_ROOT, paths);
      if (!ok) {
        queue.enqueue("push", paths);
        console.log("[duet-cell] push failed, queued");
      } else {
        // Update baseline for pushed paths
        const local = buildManifest(CELL_ROOT, hasher, defaultIgnore);
        for (const p of paths) {
          if (local[p]) baseline[p] = local[p];
        }
        saveBaseline(baseline);
      }
      hasher.save();
    },
    defaultIgnore
  );
  watcher.start();
  console.log("[duet-cell] watching for local changes (event-driven)");

  // --- Poll yote manifest for remote changes ---
  // (cell can't receive push; this is the compromise — efficient single-JSON fetch)
  setInterval(async () => {
    try {
      await reconcile();
    } catch (e) {
      console.log(`[duet-cell] reconcile error: ${e}`);
    }
  }, MANIFEST_INTERVAL_MS);
  console.log(`[duet-cell] polling yote manifest every ${MANIFEST_INTERVAL_MS}ms`);

  // Scratch watchdog — auto-delete stale temp artifacts, both sides.
  setInterval(() => { sweepStaleScratch("periodic").catch(() => {}); }, 5 * 60 * 1000);
  console.log("[duet-cell] scratch watchdog sweeping every 5m");

  // Graceful shutdown
  process.on("SIGINT", () => { watcher.stop(); hasher.save(); process.exit(0); });
  process.on("SIGTERM", () => { watcher.stop(); hasher.save(); process.exit(0); });
}

main().catch(e => { console.error("[duet-cell] fatal:", e); process.exit(1); });
