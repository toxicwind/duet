# Contributing to duet

## Setup

```bash
git clone https://github.com/toxicwind/duet.git
cd duet
cargo build          # Rust sync engine
bun install          # TypeScript orchestration layer
```

## Tests

```bash
cargo test            # Rust unit + integration tests
bun test              # TypeScript layer tests
```

## Pull requests

1. Fork the repo and create a branch (`feat/thing` or `fix/thing`).
2. Add or update tests for your change.
3. Ensure `cargo test` and `bun test` pass.
4. Fill out the PR template.
5. A maintainer will review — please respond to feedback.

## Code style

- Rust: `cargo fmt` before committing.
- TypeScript: follow the existing style (Bun runtime APIs).

## Reporting bugs

Use the bug report issue template. Include: OS, `synx --version`,
steps to reproduce, and relevant logs (`-vv`).
