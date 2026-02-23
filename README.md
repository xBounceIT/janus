# Janus

Janus is a Windows-first Tauri v2 desktop app for managing and launching SSH and RDP connections with mRemoteNG-style hierarchical connection trees. The frontend is vanilla TypeScript + Vite + xterm.js; the backend is Rust with a workspace of focused crates.

## Features

- Tauri v2 desktop shell with vanilla TypeScript frontend.
- Hierarchical connection tree CRUD (folders, SSH, RDP).
- SQLite persistence (`sqlx` migrations) with foreign-key cascading deletes.
- Encrypted local vault protected by master passphrase (Argon2id + XChaCha20Poly1305).
- SSH session open/write/resize/close command surface with terminal streaming events.
- RDP launch through `mstsc.exe` with optional temporary credential injection via `cmdkey`.
- mRemoteNG XML import/export for folders + SSH/RDP core fields.

## Repository layout

```
src/                          Frontend UI and API bindings
src-tauri/                    Tauri app and Rust backend command layer
  crates/domain               Shared DTOs and command payload types
  crates/storage              SQLite persistence and migrations
  crates/secrets              Encrypted vault implementation
  crates/protocols/ssh        SSH process/session manager
  crates/protocols/rdp        RDP launcher and credential lifecycle
  crates/import_export        mRemoteNG parser/exporter
fixtures/                     Test fixtures
docs/                         Documentation (smoke-test checklist, etc.)
```

## Prerequisites

- Rust stable toolchain with Cargo.
- Node.js 20+ and npm.
- Windows host with `ssh`, `mstsc.exe`, and `cmdkey` available in PATH.

## Local development

```bash
# Install dependencies
npm ci

# Run desktop app in dev mode (starts Vite + Tauri together)
npm run tauri dev

# Frontend-only dev server (localhost:1420, no Tauri shell)
npm run dev
```

## Validation

```bash
# Build frontend (TypeScript check + Vite bundle)
npm run build

# Rust formatting check
cargo fmt --check --manifest-path src-tauri/Cargo.toml

# Rust lint (must pass with zero warnings)
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# Run all Rust tests
cargo test --manifest-path src-tauri/Cargo.toml --workspace

# Production bundle (Windows .msi)
npm run tauri build
```

CI runs on Windows (`windows-latest`) and requires all of: `npm run build`, `cargo fmt --check`, `cargo clippy` (deny warnings), and `cargo test --workspace` to pass.

## Dependency security note (Linux GTK transitive path)

Janus currently ships and is CI-validated on Windows only. The Rust `tauri`/`wry` stack pulls Linux GTK/WebKit crates (including `glib`) as target-specific transitive dependencies for Linux builds, which can appear in `src-tauri/Cargo.lock` even when building on Windows. If GitHub Dependabot flags a `glib` advisory through that Linux-only path, validate the affected graph with:

```bash
cargo tree --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc -i glib
```

If it prints no dependency tree, treat it as not used in shipped Windows artifacts and document/dismiss the alert accordingly while tracking upstream Tauri/Wry GTK stack updates.

## Notes and current limitations

- SSH implementation currently uses system `ssh` process streaming, not a native Rust SSH protocol stack.
- `ssh_session_resize` currently no-ops until PTY-specific backend is added.
- RDP credential cleanup is best-effort and runs asynchronously after launch.
- Import/export intentionally targets core fields only in MVP.

## Next hardening items

1. Replace process-based SSH with PTY-backed Rust transport abstraction.
2. Add host-key management UX and known_hosts controls.
3. Add cleanup retry UI for failed `cmdkey` delete operations.
4. Add Playwright or WebDriver smoke e2e for desktop flow.
