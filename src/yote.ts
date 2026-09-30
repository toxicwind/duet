// duet yote daemon — watches /home/toxic/sovereign/skills/, maintains manifest.
// The cell polls the manifest (single JSON fetch). Applies incoming pushes.
// Usage: bun src/yote.ts

import { HashCache } from "./hasher";
import { DebouncedWatcher } from "./watcher";
import { buildManifest, defaultIgnore, type Manifest } from "./sync";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const YOTE_ROOT = "/home/toxic/sovereign/skills";
const YOTE_SCRATCH = "/home/toxic/.duet-scratch";
const MANIFEST_PATH = `${YOTE_SCRATCH}/duet-manifest.json`;
const CACHE_PATH = "/home/toxic/.duet/hashcache.json";

function writeManifest(m: Manifest) {
  try {
    const tmp = MANIFEST_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(m));
    require("fs").renameSync(tmp, MANIFEST_PATH); // atomic
  } catch (e) {
    console.log(`[duet-yote] manifest write failed: ${e}`);
  }
}

async function main() {
  mkdirSync("/home/toxic/.duet", { recursive: true });
  const hasher = new HashCache(CACHE_PATH);

  console.log(`[duet-yote] root=${YOTE_ROOT}`);
  mkdirSync(YOTE_SCRATCH, { recursive: true }); // persistent scratch — never /tmp tmpfs

  // Initial manifest
  const rebuild = () => {
    const m = buildManifest(YOTE_ROOT, hasher, defaultIgnore);
    hasher.save();
    writeManifest(m);
    return m;
  };

  const initial = rebuild();
  console.log(`[duet-yote] manifest: ${Object.keys(initial).length} files`);

  // Event-driven watcher — rebuild manifest on change
  const watcher = new DebouncedWatcher(
    YOTE_ROOT,
    (events) => {
      for (const e of events) hasher.invalidate(e.path);
      const m = rebuild();
      console.log(`[duet-yote] manifest updated: ${events.length} changes, ${Object.keys(m).length} files`);
    },
    defaultIgnore
  );
  watcher.start();
  console.log(`[duet-yote] watching (event-driven), manifest at ${MANIFEST_PATH}`);

  process.on("SIGINT", () => { watcher.stop(); hasher.save(); process.exit(0); });
  process.on("SIGTERM", () => { watcher.stop(); hasher.save(); process.exit(0); });
}

main().catch(e => { console.error("[duet-yote] fatal:", e); process.exit(1); });
