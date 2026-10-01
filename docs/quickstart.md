# Quickstart

## Prerequisites

- SSH access to the remote host (key-based auth recommended)
- Rust toolchain (for building from source) *or* use the install script

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/toxicwind/duet/master/install.sh | sh
```

This installs `synx` to `~/.local/bin`. Ensure it is on your `PATH`.

## Your first sync

```bash
# Create a test directory
mkdir -p ~/duet-demo && echo "hello" > ~/duet-demo/test.txt

# Sync it with a remote host (two-way, real-time)
synx ~/duet-demo user@host:~/duet-demo
```

Edit `~/duet-demo/test.txt` locally — the change appears on the remote within
seconds. Edit it on the remote — it syncs back. That is two-way sync.

## SSH setup

`synx` uses your SSH config. Add the host to `~/.ssh/config`:

```
Host myhost
    HostName 192.168.1.100
    User myuser
    IdentityFile ~/.ssh/id_ed25519
```

Then sync with the short name:

```bash
synx ~/duet-demo myhost:~/duet-demo
```

For non-standard ports or extra options:

```bash
synx ~/duet-demo myhost:~/duet-demo --ssh-opts "-p 2222"
```

## Next steps

- [Architecture](architecture.md) — how the sync engine works
- [Configuration](configuration.md) — all flags and options
