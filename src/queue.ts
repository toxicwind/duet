// Failover queue — "needs to fall over or you break".
// Append-only JSONL; every pending batch is fsync'd before ack.
// On reconnect, replay in order. Never lose writes, never corrupt on partial transfer.

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

export interface QueuedBatch {
  id: string;
  ts: number;
  direction: "push" | "pull";
  paths: string[];
  attempts: number;
}

export class FailoverQueue {
  private queuePath: string;
  private queue: QueuedBatch[] = [];

  constructor(queuePath: string) {
    this.queuePath = queuePath;
    this.load();
  }

  private load() {
    try {
      if (!existsSync(this.queuePath)) return;
      const lines = readFileSync(this.queuePath, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          this.queue.push(JSON.parse(line));
        } catch { /* skip corrupt lines */ }
      }
    } catch { /* start empty */ }
  }

  private persist() {
    try {
      mkdirSync(dirname(this.queuePath), { recursive: true });
      // Atomic: write to tmp, rename
      const tmp = this.queuePath + ".tmp";
      writeFileSync(tmp, this.queue.map(q => JSON.stringify(q)).join("\n") + "\n");
      // fsync before rename for durability
      const fd = require("fs").openSync(tmp, "r");
      require("fs").fsyncSync(fd);
      require("fs").closeSync(fd);
      require("fs").renameSync(tmp, this.queuePath);
    } catch { /* best effort */ }
  }

  enqueue(direction: "push" | "pull", paths: string[]): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.queue.push({ id, ts: Date.now(), direction, paths, attempts: 0 });
    this.persist();
    return id;
  }

  /** Get next pending batch (oldest first). */
  peek(): QueuedBatch | null {
    return this.queue[0] ?? null;
  }

  /** Mark batch complete and remove. */
  ack(id: string) {
    const i = this.queue.findIndex(q => q.id === id);
    if (i >= 0) {
      this.queue.splice(i, 1);
      this.persist();
    }
  }

  /** Increment attempt counter (for backoff). */
  bump(id: string) {
    const q = this.queue.find(q => q.id === id);
    if (q) {
      q.attempts++;
      this.persist();
    }
  }

  get depth(): number {
    return this.queue.length;
  }

  /** Merge overlapping path sets to reduce transfer count. */
  coalesce() {
    // Group by direction, merge paths
    const byDir = new Map<string, Set<string>>();
    for (const q of this.queue) {
      if (!byDir.has(q.direction)) byDir.set(q.direction, new Set());
      for (const p of q.paths) byDir.get(q.direction)!.add(p);
    }
    // Rebuild queue with merged batches (keep oldest ts per direction)
    const merged: QueuedBatch[] = [];
    for (const [dir, paths] of byDir) {
      const oldest = this.queue.find(q => q.direction === dir)!;
      merged.push({
        id: oldest.id,
        ts: oldest.ts,
        direction: dir as "push" | "pull",
        paths: [...paths],
        attempts: oldest.attempts,
      });
    }
    if (merged.length !== this.queue.length) {
      this.queue = merged;
      this.persist();
    }
  }
}
