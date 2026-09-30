// Transport over yote-conn exec — batched, never one-exec-per-file.
// Uses tar+base64 in ≤1600-char chunks (TOOLS.md: heredoc mangles above ~1.5KB).

import { $ } from "bun";
import { join } from "path";
import { tmpdir } from "os";
import { writeFileSync, readFileSync, existsSync } from "fs";

const YOTE_CONN = `${process.env.HOME}/workspace/bin/yote-conn`;

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
  if (relPaths.length === 0) return true;

  // Build tar in /tmp
  const tarPath = join(tmpdir(), `duet-push-${Date.now()}.tar.gz`);
  const files = relPaths.map(p => `"${p.replace(/"/g, '\\"')}"`).join(" ");

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
  const cmds = chunks.map((c, i) => ({
    cmd: `printf '%s' '${c}' > /tmp/duet-${batchId}-chunk-${String(i).padStart(pad, "0")}`,
    tag: `chunk-${i}`,
  }));

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
    `ls /tmp/duet-${batchId}-chunk-* 2>/dev/null | wc -l`
  );
  if (!verify.ok || parseInt(verify.stdout.trim()) !== chunks.length) {
    await yoteExec(`rm -f /tmp/duet-${batchId}-chunk-*`);
    return false;
  }

  // Concatenate, decode, extract atomically — single exec
  // Note: while-loop body uses ; not && (do && is a syntax error)
  const applyCmd = [
    `cat /tmp/duet-${batchId}-chunk-* | base64 -d > /tmp/duet-${batchId}.tar.gz`,
    `rm -f /tmp/duet-${batchId}-chunk-*`,
    `mkdir -p ${remoteRoot}.duet-incoming`,
    `tar -xzf /tmp/duet-${batchId}.tar.gz -C ${remoteRoot}.duet-incoming`,
    `cd ${remoteRoot}.duet-incoming && find . -type f -print0 | while IFS= read -r -d '' f; do dest="${remoteRoot}/$f"; mkdir -p "$(dirname "$dest")"; mv "$f" "$dest"; done`,
    `rm -rf ${remoteRoot}.duet-incoming /tmp/duet-${batchId}.tar.gz`,
    `echo OK`,
  ].join(" && ");

  const result = await yoteExec(applyCmd, 60000);
  return result.ok && result.stdout.includes("OK");
}

/** Pull a batch of files from yote. Returns map of relPath -> content. */
export async function pullBatch(
  remoteRoot: string,
  relPaths: string[]
): Promise<Map<string, Buffer> | null> {
  if (relPaths.length === 0) return new Map();

  const files = relPaths.map(p => `"${p.replace(/"/g, '\\"')}"`).join(" ");
  const remoteTar = `/tmp/duet-pull-${Date.now()}.tar.gz`;

  const cmd = [
    `tar -czf ${remoteTar} -C ${remoteRoot} ${files} 2>/dev/null`,
    `base64 -w0 ${remoteTar}`,
    `rm -f ${remoteTar}`,
  ].join(" && ");

  const r = await yoteExec(cmd, 60000);
  if (!r.ok || !r.stdout) return null;

  try {
    const tarData = Buffer.from(r.stdout.trim(), "base64");
    const localTmp = join(tmpdir(), `duet-pull-${Date.now()}.tar.gz`);
    writeFileSync(localTmp, tarData);
    // Extract to memory via tar listing
    const result = new Map<string, Buffer>();
    // Use tar to extract to a temp dir, then read
    const extractDir = join(tmpdir(), `duet-extract-${Date.now()}`);
    await $`mkdir -p ${extractDir} && tar -xzf ${localTmp} -C ${extractDir}`.quiet();
    for (const rel of relPaths) {
      const fp = join(extractDir, rel);
      if (existsSync(fp)) {
        result.set(rel, readFileSync(fp));
      }
    }
    await $`rm -rf ${localTmp} ${extractDir}`.quiet();
    return result;
  } catch {
    return null;
  }
}

/** Fetch the yote manifest (path -> {hash, mtime, size}). */
export async function fetchManifest(remoteRoot: string): Promise<Record<string, any> | null> {
  const manifestPath = "/tmp/duet-manifest.json";
  const r = await yoteExec(`cat ${manifestPath} 2>/dev/null || echo "{}"`);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}
