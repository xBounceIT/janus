# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Janus

Janus is a Windows-first Tauri v2 desktop app for managing and launching SSH and RDP connections with mRemoteNG-style hierarchical connection trees. The frontend is vanilla TypeScript + Vite + xterm.js; the backend is Rust with a workspace of focused crates.

## Development Commands

```bash
# Install dependencies
npm ci

# Run desktop app in dev mode (starts Vite + Tauri together)
npm run tauri dev

# Frontend-only dev server (localhost:1420, no Tauri shell)
npm run dev

# Build frontend (TypeScript check + Vite bundle)
npm run build

# Run all Rust tests
cargo test --manifest-path src-tauri/Cargo.toml --workspace

# Run a single crate's tests
cargo test --manifest-path src-tauri/Cargo.toml -p janus-storage

# Rust formatting check
cargo fmt --check --manifest-path src-tauri/Cargo.toml

# Rust lint (must pass with zero warnings)
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# Production bundle (Windows .msi)
npm run tauri build
```

CI runs on Windows (`windows-latest`) and requires all of: `npm run build`, `cargo fmt --check`, `cargo clippy` (deny warnings), and `cargo test --workspace` to pass.

## Architecture

### Frontend (`src/`)

Vanilla TypeScript single-page app (no framework). `main.ts` handles all UI: tree rendering, tab management, xterm.js terminal lifecycle. `api.ts` wraps all Tauri `invoke()` and `listen()` calls. `types.ts` defines shared interfaces.

### Backend (`src-tauri/`)

Tauri v2 app with commands in `commands.rs` and shared state in `state.rs`. The state holds four subsystems:

- **Storage** (`crates/storage`) — SQLite via sqlx with migrations. Polymorphic `nodes` table (folder/ssh/rdp) + `ssh_configs` and `rdp_configs` tables. Foreign-key cascading deletes.
- **Secrets** (`crates/secrets`) — Encrypted vault file (`vault.enc.json`). Argon2id key derivation + XChaCha20Poly1305 AEAD. Passwords stored as UUID references in the database, plaintext only in memory when vault is unlocked.
- **SSH** (`crates/protocols/ssh`) — Spawns system `ssh` binary as a subprocess. Streams stdout via Tauri events (`ssh://{sessionId}/stdout`). Resize is currently a no-op.
- **RDP** (`crates/protocols/rdp`) — Windows-only. Generates temp `.rdp` file, injects credentials via `cmdkey.exe`, launches `mstsc.exe`, cleans up after 8 seconds.
- **Domain** (`crates/domain`) — Shared DTOs and enums (no logic).
- **Import/Export** (`crates/import_export`) — mRemoteNG XML parsing (roxmltree) and export (quick-xml).

### Frontend ↔ Backend Communication

- **Commands**: Frontend calls `api.ts` functions → Tauri `invoke('command_name', args)` → Rust handler in `commands.rs` returns `Result<T, String>`.
- **Events**: SSH stdout/exit events emitted from async Rust tasks → frontend listens via `api.listenSshStdout(sessionId, callback)` → xterm.js renders output.

## Conventions

- Tauri command naming: `verb_noun_action` (e.g., `ssh_session_open`, `vault_unlock`)
- Commit format: `area: short summary` (e.g., `storage: add node delete guard`)
- TypeScript: 2-space indent, strict mode, explicit types on UI/backend boundary payloads
- Rust: rustfmt defaults, snake_case functions, PascalCase types
- Integration tests go in crate-level `tests/` folders (e.g., `crates/storage/tests/`)
- Manual smoke test checklist: `docs/smoke-test.md`
- Test fixtures live in `fixtures/`

## Prerequisites

Windows host with `ssh`, `mstsc.exe`, and `cmdkey` in PATH. Rust stable toolchain. Node.js 20+.
