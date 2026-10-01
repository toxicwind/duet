# SSH remote example

Sync a local project with a remote development host.

```bash
# One-time setup: ensure synx is installed on the remote
ssh myhost "curl -fsSL https://raw.githubusercontent.com/toxicwind/duet/master/install.sh | sh"

# Start two-way sync
synx ~/projects/myapp myhost:~/projects/myapp

# Deploy mode: push only, one-shot (CI/CD)
synx ~/projects/myapp myhost:/srv/myapp --mode push --once
```
