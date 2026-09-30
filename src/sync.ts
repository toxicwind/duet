// Sync engine — manifest comparison, conflict resolution, baseline.
// Borrowed from synx: three-way diff vs baseline, last-write-wins, deletion safety.

import { HashCache, type FileHash } from "./hasher";
import { readdirSync, statSync, existsSync } from "fs";
import { join, relative } from "path";

export type Manifest = Record<string, FileHash>;

export interface SyncPlan {
  push: string[];   // local newer → send to remote
  pull: string[];   // remote newer → fetch from remote
  conflicts: string[]; // both changed, mtime tie → manual review
  deletes: string[];  // in baseline but missing on one side
}

/** Walk a directory, return manifest of relPath -> hash. Skips ignores. */
export function buildManifest(
  root: string,
  hasher: HashCache,
  ignore?: (rel: string) => boolean
): Manifest {
  const manifest: Manifest = {};
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e);
      const rel = relative(root, abs);
      if (ignore?.(rel)) continue;
      if (rel.includes(".duet-tmp-")) continue;
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        // Skip .git, __pycache__, node_modules, .pyc
        if ([".git", "__pycache__", "node_modules", ".venv"].includes(e)) continue;
        walk(abs);
      } else if (st.isFile()) {
        const h = hasher.hashFile(abs, rel);
        if (h) manifest[rel] = h;
      }
    }
  };
  walk(root);
  return manifest;
}

/** Default ignore: matches synx's .gitignore-aware philosophy (simplified). */
export function defaultIgnore(rel: string): boolean {
  // Skip hidden temp files, pycache, .pyc
  if (rel.includes("__pycache__")) return true;
  if (rel.endsWith(".pyc")) return true;
  if (rel.startsWith(".")) {
    // Allow .gitignore itself, skip other dotfiles at root
    const parts = rel.split("/");
    if (parts[0].startsWith(".") && parts[0] !== ".gitignore") return true;
  }
  return false;
}

/**
 * Three-way diff: local vs remote vs baseline.
 * - New on one side → sync to other
 * - Changed on one side → last-write-wins by mtime
 * - Changed on both → higher mtime wins; tie → conflict
 * - Deleted on one side (was in baseline) → propagate delete
 */
export function planSync(
  local: Manifest,
  remote: Manifest,
  baseline: Manifest
): SyncPlan {
  const plan: SyncPlan = { push: [], pull: [], conflicts: [], deletes: [] };
  const allPaths = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(baseline)]);

  for (const p of allPaths) {
    const l = local[p];
    const r = remote[p];
    const b = baseline[p];

    if (l && !r && !b) {
      // New local file → push
      plan.push.push(p);
    } else if (!l && r && !b) {
      // New remote file → pull
      plan.pull.push(p);
    } else if (l && r) {
      if (l.hash === r.hash) continue; // converged
      // Both exist, hashes differ → who changed?
      const lChanged = !b || b.hash !== l.hash;
      const rChanged = !b || b.hash !== r.hash;
      if (lChanged && !rChanged) {
        plan.push.push(p);
      } else if (!lChanged && rChanged) {
        plan.pull.push(p);
      } else if (lChanged && rChanged) {
        // Both changed → last-write-wins
        if (l.mtime > r.mtime) plan.push.push(p);
        else if (r.mtime > l.mtime) plan.pull.push(p);
        else plan.conflicts.push(p); // true tie
      }
    } else if (!l && r && b) {
      // Deleted locally, exists remotely, was in baseline → propagate delete to remote
      // (handled by caller via delete batch)
      plan.deletes.push(`remote:${p}`);
    } else if (l && !r && b) {
      // Deleted remotely → propagate delete locally
      plan.deletes.push(`local:${p}`);
    }
    // (!l && !r && b) → deleted on both, drop from baseline
  }

  return plan;
}
