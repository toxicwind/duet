# duet

> Real-time two-way file sync. A performance by two.

Forked from [Muvon/synx](https://github.com/Muvon/synx) (Rust), rebuilt **Bun-forward** in TypeScript for the sovereign estate.

## Why duet

- **Event-driven, never polling** (for local changes): `fs.watch` with 200ms debounce coalesces editor save storms. No timers.
- **μ-speed transfers**: batched tar+base64, chunks upload in parallel via `yote-conn multi`, zero-padded for correct reassembly.
- **Failover**: append-only JSONL queue, fsync'd before ack. Bridge down? Changes queue locally, replay on reconnect. Never lose writes.
- **Conflict resolution**: three-way diff vs baseline, last-write-wins by mtime, ties flagged for review. Dirty WIP preserved.
- **Atomic writes**: tmp+rename, never partial files (synx pattern).

## Architecture (borrowed from synx)

```
cell (~/workspace/skills)                    yote (/home/toxic/sovereign/skills)
┌─────────────────────┐                      ┌─────────────────────┐
│ cell.ts             │                      │ yote.ts             │
│ ├─ fs.watch (event) │──pushBatch──────────▶│ ├─ fs.watch (event) │
│ ├─ manifest poll    │◀──/tmp/duet-manifest─│ └─ manifest writer  │
│ └─ failover queue   │   (10s, single JSON) │                     │
└─────────────────────┘                      └─────────────────────┘
         │ transport.ts: yote-conn exec, parallel chunk upload
```

Modules:
- `hasher.ts` — Bun.hash content cache (skip re-hashing unchanged files)
- `watcher.ts` — debounced fs.watch (200ms, synx's DEBOUNCE)
- `queue.ts` — failover queue (append-only JSONL, coalesce, replay)
- `sync.ts` — manifest build, three-way planSync, defaultIgnore
- `transport.ts` — yote-conn exec, pushBatch (parallel), pullBatch, fetchManifest
- `cell.ts` — cell daemon (watch + push, poll manifest + pull)
- `yote.ts` — yote daemon (watch + manifest writer)

## Usage

```bash
# cell daemon (systemd or nohup)
bun src/cell.ts

# yote daemon (systemd user unit: duet-yote.service)
bun src/yote.ts

# one-shot sync and exit
bun src/cell.ts --once

# status
bun src/cli.ts status
```

## Deployment

- **yote**: systemd user unit `duet-yote.service` (enabled, restart=always)
- **cell**: `bun src/cell.ts` via nohup (TODO: proper supervisor)

## License

Apache-2.0 (inherited from synx)
