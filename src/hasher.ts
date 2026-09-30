// Content hashing with persistent cache — borrowed from synx's blake3-cached pattern.
// Uses Bun.hash (xxh3) for speed; cache avoids re-hashing unchanged files.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface FileHash {
  hash: string;
  mtime: number;
  size: number;
}

export class HashCache {
  private cache = new Map<string, FileHash>();
  private cachePath: string;
  private dirty = false;

  constructor(cachePath: string) {
    this.cachePath = cachePath;
    this.load();
  }

  private load() {
    try {
      if (existsSync(this.cachePath)) {
        const data = JSON.parse(readFileSync(this.cachePath, "utf-8"));
        for (const [k, v] of Object.entries(data)) {
          this.cache.set(k, v as FileHash);
        }
      }
    } catch { /* start fresh */ }
  }

  save() {
    if (!this.dirty) return;
    try {
      mkdirSync(join(this.cachePath, ".."), { recursive: true });
      const obj: Record<string, FileHash> = {};
      for (const [k, v] of this.cache) obj[k] = v;
      writeFileSync(this.cachePath, JSON.stringify(obj));
      this.dirty = false;
    } catch { /* best effort */ }
  }

  /** Hash a file, using cache if mtime+size match. Returns null for missing/unreadable. */
  hashFile(absPath: string, relPath: string): FileHash | null {
    try {
      const stat = Bun.file(absPath);
      // Use fs stat for mtime
      const fsStat = require("fs").statSync(absPath);
      const mtime = fsStat.mtimeMs;
      const size = fsStat.size;

      const cached = this.cache.get(relPath);
      if (cached && cached.mtime === mtime && cached.size === size) {
        return cached;
      }

      const content = readFileSync(absPath);
      const hash = Bun.hash(content).toString(16);
      const entry = { hash, mtime, size };
      this.cache.set(relPath, entry);
      this.dirty = true;
      return entry;
    } catch {
      return null;
    }
  }

  invalidate(relPath: string) {
    if (this.cache.delete(relPath)) this.dirty = true;
  }

  get(relPath: string): FileHash | null {
    return this.cache.get(relPath) ?? null;
  }
}
