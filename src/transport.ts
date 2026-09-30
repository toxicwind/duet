// Transport over yote-conn exec — batched, never one-exec-per-file.
// Uses tar+base64 in ≤1600-char chunks (TOOLS.md: heredoc mangles above ~1.5KB).

import { $ } from "bun";
import { join } from "path";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";

const YOTE_CONN = `${process.env.HOME}/workspace/bin/yote-conn`;

// Persistent scratch — NEVER the cell's 512M /tmp tmpfs (Chris 2026-09-30:
// duet's retry loop filled tmpfs and broke everything). Same on yote.
const SCRATCH_DIR = join(process.env.HOME!, ".duet", "scratch");
mkdirSync(SCRATCH_DIR, { recursive: true });
const YOTE_SCRATCH = "/home/toxic/.duet-scratch";

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run a command on yote via yote-conn. Unwraps both output shapes. */
export async function yoteExec(cmd: string, timeoutMs = 30000): Promise<ExecResult> {
  try {
    const proc = Bun.spawn([YOTE_CONN, "exec", cmd], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${process.env.HOME}/workspace/bin:${process.env.PATH}` },
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    // Unwrap JSON envelope shape if present
    let out = stdout.trim();
    try {
      const parsed = JSON.parse(out);
      if (parsed && typeof parsed.stdout === "string") out = parsed.stdout;
    } catch { /* raw stdout */ }
    return { ok: code === 0, stdout: out, stderr: stderr.trim() };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
}

/** Push a batch of files to yote via tar+base64. Atomic: extract to tmp, then rename.
 *  μ-speed: chunks upload in PARALLEL via yote-conn multi, then concatenated on yote. */
export async function pushBatch(
  localRoot: string,
  remoteRoot: string,
  relPaths: string[]
): Promise<boolean> {
  // Filter to files that actually exist (skip deleted/missing — they're handled by planSync)
  const existing = relPaths.filter(p => {
    try {
      return existsSync(join(localRoot, p));
    } catch {
      return false;
    }
  });
  if (existing.length === 0) return true; // nothing to push (all missing)
  const relPathsFiltered = existing;

  // Build tar in persistent scratch (never /tmp tmpfs)
  const tarPath = join(SCRATCH_DIR, `duet-push-${Date.now()}.tar.gz`);
  const files = relPathsFiltered.map(p => `"${p.replace(/"/g, '\\"')}"`).join(" ");

  try {
    await $`tar -czf ${tarPath} -C ${localRoot} ${{ raw: files }}`.quiet();
  } catch {
    return false;
  }

  // Base64 encode
  const b64 = Buffer.from(readFileSync(tarPath)).toString("base64");
  try { require("fs").unlinkSync(tarPath); } catch {}

  // Split into chunks, upload in PARALLEL via yote-conn multi
  const CHUNK = 60000; // 60KB per chunk (safe for argv)
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += CHUNK) {
    chunks.push(b64.slice(i, i + CHUNK));
  }

  const batchId = Date.now();
  const pad = String(chunks.length).length;
  const cmds = [
    { cmd: `mkdir -p ${YOTE_SCRATCH}`, tag: "mkdir" },
    ...chunks.map((c, i) => ({
      cmd: `printf '%s' '${c}' > ${YOTE_SCRATCH}/duet-${batchId}-chunk-${String(i).padStart(pad, "0")}`,
      tag: `chunk-${i}`,
    })),
  ];

  // Single multi call uploads all chunks in parallel
  const multiProc = Bun.spawn(
    [YOTE_CONN, "multi", "-"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
  );
  multiProc.stdin!.write(JSON.stringify(cmds));
  multiProc.stdin!.end();
  const multiOut = await new Response(multiProc.stdout).text();
  await multiProc.exited;

  // Verify all chunks landed
  const verify = await yoteExec(
    `ls ${YOTE_SCRATCH}/duet-${batchId}-chunk-* 2>/dev/null | wc -l`
  );
  if (!verify.ok || parseInt(verify.stdout.trim()) !== chunks.length) {
    await yoteExec(`rm -f ${YOTE_SCRATCH}/duet-${batchId}-chunk-*`);
    return false;
  }

  // Concatenate, decode, extract atomically — single exec
  // Note: while-loop body uses ; not && (do && is a syntax error)
  const applyCmd = [
    `cat ${YOTE_SCRATCH}/duet-${batchId}-chunk-* | base64 -d > ${YOTE_SCRATCH}/duet-${batchId}.tar.gz`,
    `rm -f ${YOTE_SCRATCH}/duet-${batchId}-chunk-*`,
    `mkdir -p ${remoteRoot}.duet-incoming`,
    `tar -xzf ${YOTE_SCRATCH}/duet-${batchId}.tar.gz -C ${remoteRoot}.duet-incoming`,
    `cd ${remoteRoot}.duet-incoming && find . -type f -print0 | while IFS= read -r -d '' f; do dest="${remoteRoot}/$f"; mkdir -p "$(dirname "$dest")"; mv "$f" "$dest"; done`,
    `rm -rf ${remoteRoot}.duet-incoming ${YOTE_SCRATCH}/duet-${batchId}.tar.gz`,
    `echo OK`,
  ].join(" && ");

  const result = await yoteExec(applyCmd, 60000);
  return result.ok && result.stdout.includes("OK");
}

/** Pull a batch of files from yote. Returns map of relPath -> content.
 *  Chunked: the exec path truncates stdout at ~200KB, so a tarball that
 *  base64s larger than that never arrives whole. We split the base64
 *  into 60KB chunks on yote and fetch them one at a time, then reassemble
 *  locally. All temp artifacts (local + remote) are removed in `finally`. */
export async function pullBatch(
  remoteRoot: string,
  relPaths: string[]
): Promise<Map<string, Buffer> | null> {
  if (relPaths.length === 0) return new Map();

  const files = relPaths.map(p => `"${p.replace(/"/g, '\\"')}"`).join(" ");
  const batchId = Date.now();
  const CHUNK = 60000; // base64 chars per chunk — well under the ~200KB stdout cap
  const SUFFIX_LEN = 3; // split -a 3: supports up to 1000 chunks (~60MB tarball)

  // 1. Tar + base64 + split into numeric-suffixed chunks on yote. Prints chunk count.
  const prepCmd = [
    `mkdir -p ${YOTE_SCRATCH}`,
    `tar -czf ${YOTE_SCRATCH}/duet-pull-${batchId}.tar.gz -C ${remoteRoot} ${files} 2>/dev/null`,
    `base64 -w0 ${YOTE_SCRATCH}/duet-pull-${batchId}.tar.gz | split -b ${CHUNK} -d -a ${SUFFIX_LEN} - ${YOTE_SCRATCH}/duet-pull-${batchId}-chunk-`,
    `rm -f ${YOTE_SCRATCH}/duet-pull-${batchId}.tar.gz`,
    `ls ${YOTE_SCRATCH}/duet-pull-${batchId}-chunk-* 2>/dev/null | wc -l`,
  ].join(" && ");

  const cleanupRemote = () =>
    yoteExec(`rm -f ${YOTE_SCRATCH}/duet-pull-${batchId}.tar.gz ${YOTE_SCRATCH}/duet-pull-${batchId}-chunk-*`);

  const prep = await yoteExec(prepCmd, 60000);
  const nChunks = parseInt((prep.stdout || "").trim(), 10);
  if (!prep.ok || !nChunks || nChunks <= 0) {
    await cleanupRemote();
    return null;
  }

  const localTmp = join(SCRATCH_DIR, `duet-pull-${batchId}.tar.gz`);
  const extractDir = join(SCRATCH_DIR, `duet-extract-${batchId}`);
  try {
    // 2. Fetch each chunk (each small, under the stdout cap) and reassemble.
    let b64 = "";
    for (let i = 0; i < nChunks; i++) {
      const suffix = String(i).padStart(SUFFIX_LEN, "0");
      const r = await yoteExec(`cat ${YOTE_SCRATCH}/duet-pull-${batchId}-chunk-${suffix}`, 30000);
      if (!r.ok || !r.stdout) return null;
      b64 += r.stdout.trim();
    }
    const tarData = Buffer.from(b64, "base64");
    writeFileSync(localTmp, tarData);
    // Extract to a temp dir, then read the requested files
    const result = new Map<string, Buffer>();
    await $`mkdir -p ${extractDir} && tar -xzf ${localTmp} -C ${extractDir}`.quiet();
    for (const rel of relPaths) {
      const fp = join(extractDir, rel);
      if (existsSync(fp)) {
        result.set(rel, readFileSync(fp));
      }
    }
    return result;
  } catch {
    return null;
  } finally {
    try {
      await $`rm -rf ${localTmp} ${extractDir}`.quiet();
    } catch { /* best effort */ }
    await cleanupRemote();
  }
}

/** Fetch the yote manifest (path -> {hash, mtime, size}). */
export async function fetchManifest(remoteRoot: string): Promise<Record<string, any> | null> {
  const manifestPath = `${YOTE_SCRATCH}/duet-manifest.json`;
  const r = await yoteExec(`cat ${manifestPath} 2>/dev/null || echo "{}"`);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}
