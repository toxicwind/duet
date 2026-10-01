# Architecture

## Components

| Component | Language | Role |
|-----------|----------|------|
| `synx` binary | Rust | Sync engine: watch, hash, transfer, apply |
| `duet` CLI | TypeScript (Bun) | Orchestration layer: daemon management, status |

## Sync engine (Rust)

### Watch
Both sides monitor their directories for filesystem events. Events are
debounced (200ms) to coalesce editor save storms — a file saved 5 times in
a second triggers one sync, not five.

### Hash
Changed files are hashed with blake3. A content cache skips re-hashing
files whose mtime and size are unchanged since the last sync.

### Transfer
Deltas are computed rsync-style: only changed blocks move over the wire.
Transfers use zstd compression (disable with `--no-compress`). Multiple
files transfer in parallel.

### Apply
Each side applies incoming changes atomically via tmp+rename — a crash
mid-apply never leaves a partial file.

### Conflict resolution
When both sides change the same file since the last baseline, duet performs
a three-way diff against the shared baseline:
- If one side matches the baseline, the other side wins.
- If both differ, last-write-wins by mtime.
- If mtimes tie, the conflict is flagged for manual review.
- Dirty work-in-progress is never overwritten silently.

### Failover
All pending operations go through an append-only JSONL queue, fsyncd before
acknowledgment. If the connection drops, changes accumulate locally and
replay in order when connectivity returns.

## Orchestration layer (TypeScript)

The Bun layer (`src/cell.ts`, `src/yote.ts`) provides event-driven daemon
management for persistent sync pairs: debounced `fs.watch`, manifest
exchange, and the failover queue. See the source for the estate-specific
configuration.

## Wire protocol

`synx` speaks SSH. The local side spawns `ssh <host> synx --agent` on the
remote (the remote must have `synx` installed). All sync traffic flows
over the SSH connection — no additional ports, no daemons on the remote
beyond the `synx` process itself.
