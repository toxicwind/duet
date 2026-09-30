#!/usr/bin/env bun
// duet CLI — real-time two-way file sync. A performance by two.
// Forked from Muvon/synx, rebuilt Bun-forward.

const [,, cmd, ...args] = process.argv;

const help = `
duet — real-time two-way file sync (cell <-> yote)

Usage:
  duet cell [--once]    Run the cell daemon (watches ~/workspace/skills/)
  duet yote             Run the yote daemon (watches /home/toxic/sovereign/skills/)
  duet status           Show sync status (queue depth, manifest sizes)
  duet help             This help

Architecture (borrowed from synx):
  - Event-driven: fs.watch with 200ms debounce (no polling for local changes)
  - Content-hash cache: Bun.hash, skip re-hashing unchanged files
  - Batched transfers: tar+base64 in chunks (never one-exec-per-file)
  - Failover queue: append-only JSONL, replay on reconnect, never lose writes
  - Conflict resolution: last-write-wins by mtime, ties flagged for review
  - Atomic writes: tmp+rename, never partial files
`;

async function main() {
  switch (cmd) {
    case "cell":
      await import("./cell.ts");
      break;
    case "yote":
      await import("./yote.ts");
      break;
    case "status": {
      const { existsSync, readFileSync } = await import("fs");
      const qPath = `${process.env.HOME}/.duet/queue.jsonl`;
      const bPath = `${process.env.HOME}/.duet/baseline.json`;
      let qDepth = 0, bSize = 0;
      try {
        if (existsSync(qPath)) qDepth = readFileSync(qPath, "utf-8").split("\n").filter(Boolean).length;
        if (existsSync(bPath)) bSize = Object.keys(JSON.parse(readFileSync(bPath, "utf-8"))).length;
      } catch {}
      console.log(`queue depth: ${qDepth}`);
      console.log(`baseline files: ${bSize}`);
      // Check daemons
      const proc = Bun.spawnSync(["pgrep", "-f", "duet/src/cell"]);
      console.log(`cell daemon: ${proc.exitCode === 0 ? "RUNNING" : "STOPPED"}`);
      break;
    }
    default:
      console.log(help);
  }
}

main();
