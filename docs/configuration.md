# Configuration

## CLI reference

```
synx [OPTIONS] [LOCAL] [REMOTE]
```

| Argument | Description |
|----------|-------------|
| `[LOCAL]` | Local directory to sync (or, with `--agent`, the remote-side path) |
| `[REMOTE]` | Remote target as `[user@]host:/path` |

| Flag | Description |
|------|-------------|
| `-m, --mode <MODE>` | `push` (local→remote), `pull` (remote→local), `both` (bidirectional, default) |
| `--once` | Single sync and exit; do not enter live-watch mode |
| `--ssh-opts <OPTS>` | Extra ssh arguments, e.g. `"-p 2222 -i ~/.ssh/key"` |
| `--no-compress` | Disable zstd on-the-wire compression |
| `--agent` | Run as the remote agent (invoked automatically over SSH) |
| `-v` | Increase verbosity (`-v`, `-vv`) |

## Ignore rules

`synx` respects `.gitignore` in the synced directories. Additional excludes
can be layered via the orchestration layer configuration.

## Environment

| Variable | Description |
|----------|-------------|
| `SYNX_INSTALL_DIR` | Override install location for `install.sh` (default `~/.local/bin`) |
