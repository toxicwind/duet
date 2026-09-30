// Debounced filesystem watcher — borrowed from synx's watcher.rs.
// 200ms debounce coalesces editor save storms; 100ms tick flushes.

import { watch, type FSWatcher } from "fs";
import { join, relative } from "path";

export type FsEventType = "created" | "modified" | "removed" | "renamed";

export interface FsEvent {
  type: FsEventType;
  path: string;      // relative to root
  from?: string;     // for renames
}

const DEBOUNCE_MS = 200;

export class DebouncedWatcher {
  private watchers: FSWatcher[] = [];
  private pending = new Map<string, FsEvent>();
  private timer: Timer | null = null;
  private onBatch: (events: FsEvent[]) => void;
  private root: string;
  private ignore: (rel: string) => boolean;

  constructor(
    root: string,
    onBatch: (events: FsEvent[]) => void,
    ignore?: (rel: string) => boolean
  ) {
    this.root = root;
    this.onBatch = onBatch;
    this.ignore = ignore ?? (() => false);
  }

  start() {
    // Watch root recursively
    const w = watch(this.root, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const rel = relative(this.root, join(this.root, filename.toString()));
      if (!rel || this.ignore(rel)) return;
      // Skip our own temp files
      if (rel.includes(".duet-tmp-")) return;

      let type: FsEventType;
      if (eventType === "rename") {
        // rename covers create+delete; disambiguate via existence
        try {
          const stat = Bun.file(join(this.root, rel));
          // Bun.file doesn't throw for missing; check via fs
          require("fs").statSync(join(this.root, rel));
          type = "created";
        } catch {
          type = "removed";
        }
      } else {
        type = "modified";
      }

      this.pending.set(rel, { type, path: rel });
      this.scheduleFlush();
    });
    this.watchers.push(w);
  }

  private scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const events = [...this.pending.values()];
      this.pending.clear();
      if (events.length > 0) this.onBatch(events);
    }, DEBOUNCE_MS);
  }

  stop() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
