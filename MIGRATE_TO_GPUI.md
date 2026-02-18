# Migrate to GPUI

## Objective
Migrate Janus from `TypeScript + Tauri` to a native `Rust + GPUI` application with full feature parity, Windows-first support, and production readiness.

## Scope
- In scope:
  - Replace Tauri/webview frontend with GPUI.
  - Preserve current behavior: vault flows, tree CRUD, SSH, RDP, import/export, session tabs, status UX.
  - Reuse existing Rust domain/storage/secrets/protocol crates wherever possible.
- Out of scope:
  - Net-new product features during migration.
  - Major protocol redesign beyond parity fixes required for GPUI integration.

## Current Baseline
- Frontend:
  - `src/main.ts` is the main UI runtime (~2.3k LOC), DOM-driven.
  - `src/api.ts` wraps Tauri `invoke/listen` commands/events.
- Backend:
  - Tauri-specific boundary mainly in `src-tauri/src/main.rs` and `src-tauri/src/commands.rs`.
  - Core logic lives in reusable crates under `src-tauri/crates/*`.

---

## Phase 0 - Discovery and Technical Spike

### Goals
- Validate GPUI feasibility on Windows for Janus requirements.
- De-risk terminal rendering/input and RDP frame rendering/input.

### Tasks
- Create GPUI app bootstrap and confirm window lifecycle on Windows.
- Validate async task model: tokio channels feeding GPUI state updates.
- Build mini proof of concept:
  - SSH stream text rendering and keyboard input.
  - RDP frame draw path + mouse/keyboard event capture.
- Record performance and UX constraints.

### Exit Criteria
- Windows startup and event loop are stable.
- Terminal and RDP rendering/input strategies are selected and documented.
- No blocker remains for full rewrite.

---

## Phase 1 - Backend Decoupling from Tauri

### Goals
- Isolate product logic from Tauri transport layer.
- Preserve existing behavior while preparing GPUI integration.

### Tasks
- Introduce app service layer crate (example: `src-tauri/crates/app_services`):
  - `VaultService`
  - `TreeService`
  - `SshService`
  - `RdpService`
  - `ImportExportService`
- Move logic from `src-tauri/src/commands.rs` into services.
- Keep Tauri commands as thin wrappers calling services.
- Replace stringly event contracts with typed channel/event interfaces internally.
- Add tests for service behaviors extracted from command handlers.

### Exit Criteria
- Tauri app still works with unchanged behavior.
- Core logic no longer depends on Tauri macros/types.

---

## Phase 2 - GPUI App Foundation

### Goals
- Build the new GPUI shell and core state architecture.
- Reach parity for non-session workflows.

### Tasks
- Create new GPUI binary crate (for example `apps/janus-gpui`).
- Implement app state store and action dispatch pattern.
- Implement layout:
  - toolbar
  - sidebar tree
  - workspace/tabs container
  - status bar
- Implement vault workflows:
  - initialize
  - unlock
  - lock
  - startup state handling
- Implement tree and modal flows:
  - folder create/rename/delete
  - connection create/edit/delete
  - field validation parity

### Exit Criteria
- User can perform all vault and tree CRUD flows in GPUI.
- Behavior matches current app semantics.

---

## Phase 3 - SSH Feature Parity

### Goals
- Complete SSH tab lifecycle and interaction parity.

### Tasks
- Implement tab management and focus behavior in GPUI.
- Wire `SshService`:
  - open
  - write
  - resize
  - close
  - stdout/exit events
- Implement terminal UI adapter:
  - text render
  - input capture
  - resize propagation
- Implement host-key mismatch UX and retry/update flow.
- Preserve multi-session-per-node behavior.

### Exit Criteria
- SSH smoke paths pass end-to-end with parity.

---

## Phase 4 - RDP Feature Parity

### Goals
- Complete RDP session rendering/input parity in GPUI.

### Tasks
- Implement RDP session tabs and lifecycle.
- Wire `RdpService`:
  - open
  - close
  - mouse events
  - key events
  - frame/exit events
- Render decoded frame updates to GPUI surface.
- Map GPUI input events to RDP protocol event model.
- Handle disconnect/failure UX consistently with current behavior.

### Exit Criteria
- RDP sessions open, render, accept input, and close correctly.

---

## Phase 5 - Import/Export and Remaining UX Parity

### Goals
- Complete remaining feature surface outside session protocols.

### Tasks
- Implement mRemoteNG import UI:
  - dry run
  - apply
  - report display
- Implement export workflow and file path handling.
- Recreate status messages and error surfacing parity.
- Recreate context menus, keyboard shortcuts, and modal dismissal behaviors.

### Exit Criteria
- Import/export and UX interactions align with current app behavior.

---

## Phase 6 - Hardening, Testing, and Packaging

### Goals
- Reach production quality and replace Tauri build/distribution path.

### Tasks
- Execute and expand smoke checklist from `docs/smoke-test.md` for GPUI.
- Add regression tests for:
  - service layer
  - critical UI state transitions
  - session cleanup paths
- Validate shutdown/session resource cleanup under repeated open/close cycles.
- Create Windows packaging/distribution flow for GPUI app.
- Prepare migration notes for contributors (new run/build/test commands).

### Exit Criteria
- Full smoke suite passes on Windows.
- Packaging pipeline produces releasable artifacts.
- Team docs updated.

---

## Phase 7 - Cutover and Cleanup

### Goals
- Make GPUI the primary app and retire Tauri frontend path.

### Tasks
- Switch default development and CI entry points to GPUI.
- Archive/remove obsolete Tauri frontend assets (`src/`, Vite/Tauri web bindings) when safe.
- Keep reusable Rust crates and tests.
- Final pass on docs:
  - README
  - AGENTS guidance updates
  - troubleshooting

### Exit Criteria
- GPUI app is default and supported path.
- Legacy Tauri/webview frontend removed or clearly archived.

---

## Acceptance Criteria (Complete Migration)
- Feature parity achieved for:
  - vault setup/unlock/lock
  - tree CRUD
  - SSH tabs and I/O
  - RDP sessions and input
  - import/export
- Windows-first quality target met.
- No dependence on Tauri `invoke/listen` runtime remains.
- CI/test/docs/build workflows updated for GPUI-first development.

## Risks and Mitigations
- GPUI Windows edge cases:
  - Mitigation: early spike, phased validation, keep old app runnable during transition.
- Terminal parity risk:
  - Mitigation: dedicated adapter boundary and phased hardening.
- RDP render/input latency:
  - Mitigation: profile frame pipeline early; optimize batching and draw strategy.
- Migration fatigue/regression risk:
  - Mitigation: strict phase gates and smoke checks at each phase.
