# duet

[![CI](https://github.com/toxicwind/duet/actions/workflows/ci.yml/badge.svg)](https://github.com/toxicwind/duet/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.4-blue.svg)](CHANGELOG.md)

> Real-time two-way file sync over SSH. A simpler Mutagen alternative.

`duet` keeps two directories in sync — local and remote — in real time, over SSH. No daemons to babysit, no polling loops, no cloud. Edit a file, it's there. On both sides. That's the whole pitch.

Built on a Rust sync engine (forked from [Muvon/synx](https://github.com/Muvon/synx)) with a Bun/TypeScript orchestration layer.

## Quickstart

```bash
# Install (Linux/macOS)
curl -fsSL https://raw.githubusercontent.com/toxicwind/duet/master/install.sh | sh

# Two-way real-time sync: local ./app <-> remote host:/srv/app
synx ./app host:/srv/app

# One-shot sync and exit (no watch)
synx ./app host:/srv/app --once

# Push only (deploy mode)
synx ./app host:/srv/app --mode push

# Pull only (backup mode)
synx /var/log host:/backup --mode pull --once
```

That's it. `synx` watches both sides, transfers deltas, resolves conflicts, and keeps going.

## Why duet

- **Real-time, event-driven** — filesystem events with 200ms debounce coalesce editor save storms. No polling intervals, no timers.
- **Fast transfers** — blake3 content hashing skips unchanged files; rsync-style deltas move only what changed; zstd compression on the wire.
- **Two-way by default** — changes flow both directions. Not a deploy tool, a sync tool. (Or pick `--mode push` / `--mode pull`.)
- **Resilient** — append-only queue, fsync'd before ack. Connection drops? Changes queue locally and replay on reconnect. Never lose writes.
- **Conflict resolution** — three-way diff against baseline, last-write-wins by mtime, ties flagged for review. Dirty work-in-progress is preserved, never clobbered.
- **Atomic writes** — tmp+rename, never partial files.
- **`.gitignore`-aware** — respects your ignore rules out of the box.

## How it works

```
┌─────────────┐                          ┌─────────────┐
│   LOCAL     │                          │   REMOTE    │
│             │                          │  (over SSH) │
│ fs events   │──── changed files ──────▶│ apply delta │
│ (watch)     │                          │             │
│             │◀──── changed files ──────│ fs events   │
│ apply delta │                          │ (watch)     │
└─────────────┘                          └─────────────┘
       │ blake3 hash cache │         │ rsync-style deltas │
       │ failover queue (fsync before ack)                │
```

1. **Watch** — both sides watch for filesystem events (debounced).
2. **Hash** — changed files are blake3-hashed; unchanged files are skipped via cache.
3. **Transfer** — deltas move over SSH with zstd compression.
4. **Apply** — each side applies atomically (tmp+rename). Conflicts go through three-way merge.

See [docs/architecture.md](docs/architecture.md) for the full design.

## Installation

**Quick install** (Linux/macOS):
```bash
curl -fsSL https://raw.githubusercontent.com/toxicwind/duet/master/install.sh | sh
```

**From source** (requires Rust):
```bash
git clone https://github.com/toxicwind/duet.git
cd duet
cargo build --release
./target/release/synx --help
```

**Bun/TypeScript orchestration layer** (event-driven sync daemon):
```bash
bun install
bun src/cell.ts --once    # one-shot sync and exit
bun src/cell.ts           # run the watch daemon
```

See [docs/quickstart.md](docs/quickstart.md) for detailed setup including SSH configuration.

## Usage

```bash
# Two-way real-time sync (default mode)
synx ./local-dir user@host:/remote-dir

# With specific SSH options
synx ./local-dir user@host:/remote-dir --ssh-opts "-i ~/.ssh/id_ed25519 -p 2222"

# Dry run via verbose (show what would transfer)
synx ./local-dir user@host:/remote-dir --once -v

# Disable compression (fast local networks)
synx ./local-dir user@host:/remote-dir --no-compress
```

## Examples

See [examples/](examples/) for runnable configurations:
- [basic-sync](examples/basic-sync/) — minimal two-way sync between two local directories
- [ssh-remote](examples/ssh-remote/) — sync with a remote host over SSH

## Documentation

- [Quickstart](docs/quickstart.md) — detailed setup, SSH config, first sync
- [Architecture](docs/architecture.md) — how the sync engine works
- [Configuration](docs/configuration.md) — all options and flags

## Roadmap

- [x] Real-time two-way sync over SSH (Rust core)
- [x] blake3 content hashing and delta transfers
- [x] Conflict resolution (three-way merge)
- [x] Failover queue with replay
- [x] Bun/TypeScript orchestration layer
- [ ] Windows support
- [ ] Bandwidth limiting (`--bwlimit`)
- [ ] Interactive exclude builder
- [ ] Prometheus metrics endpoint

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and feature requests welcome — please use the issue templates.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

Apache-2.0 — see [LICENSE](LICENSE). Forked from [Muvon/synx](https://github.com/Muvon/synx) (also Apache-2.0).
