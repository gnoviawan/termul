# Termul Manager - Source Tree Analysis

**Date:** 2026-05-09

## Overview

Termul Manager is organized as a single desktop application repository with a clear split between renderer code, shared contracts, and the Tauri/Rust runtime. The dominant implementation surface is in `src/renderer/`, while `src-tauri/` provides native capabilities and packaging assets.

## Complete Directory Structure

```text
termul/
├── .github/                     # CI, PR validation, release, packaging workflows
│   └── workflows/
├── docs/                        # Generated docs, operational notes, verification docs
├── img/                         # Screenshot assets used in README/docs
├── public/                      # Static web assets
├── scripts/                     # Repository scripts/utilities
├── src/
│   ├── renderer/                # React + TypeScript renderer application
│   │   ├── components/          # UI components by feature and primitives
│   │   │   ├── browser/         # Embedded browser + annotation UI
│   │   │   ├── editor/          # Code/markdown editing surfaces
│   │   │   ├── file-explorer/   # File tree and file actions
│   │   │   ├── terminal/        # xterm/PTY-backed terminal UI
│   │   │   ├── ui/              # Shared design-system primitives
│   │   │   └── workspace/       # Pane and tab composition system
│   │   ├── hooks/               # Renderer orchestration hooks
│   │   ├── layouts/             # Top-level layout shells
│   │   ├── lib/                 # Runtime adapters and integration helpers
│   │   ├── pages/               # Route-level screens
│   │   ├── stores/              # Zustand state domains
│   │   ├── types/               # Renderer-specific domain models
│   │   ├── utils/               # Utility helpers
│   │   ├── App.tsx              # Browser/dev-safe app bootstrap target
│   │   ├── TauriApp.tsx         # Tauri-first canonical desktop app component
│   │   ├── main.tsx             # Runtime-sensitive bootstrap selector
│   │   └── tauri-main.tsx       # Tauri-only bootstrap entry
│   └── shared/
│       └── types/               # Shared IPC, persistence, updater, filesystem types
├── src-tauri/
│   ├── src/                     # Rust runtime modules
│   │   ├── pty/                 # PTY implementation and OS-specific terminal logic
│   │   ├── trackers/            # cwd, git, and exit-code trackers
│   │   ├── browser_tab_manager.rs
│   │   ├── commands.rs
│   │   ├── lib.rs               # Tauri composition root
│   │   ├── main.rs              # Native binary entrypoint
│   │   └── migrations.rs
│   ├── resources/               # Injected browser resources
│   ├── icons/                   # Packaging icons for all platforms
│   ├── Cargo.toml               # Rust package definition
│   ├── tauri.conf.json          # Main Tauri configuration
│   └── tauri.conf.prod.json     # Production build overrides
├── README.md                    # User and developer overview
├── CONTRIBUTING.md              # Contribution workflow and standards
├── package.json                 # JS package manifest and scripts
├── vite.config.ts               # Vite config
├── vite.config.tauri.ts         # Tauri-specific Vite config
└── tailwind.config.ts           # Tailwind styling config
```

## Critical Directories

### `src/renderer/`

**Purpose:** Main frontend application.
**Contains:** Application shell, feature surfaces, state stores, hooks, and runtime adapters.
**Entry Points:** `main.tsx`, `tauri-main.tsx`, `App.tsx`, `TauriApp.tsx`

### `src/renderer/components/`

**Purpose:** UI composition by feature area.
**Contains:** Browser, editor, file explorer, terminal, workspace, and shared UI primitives.

### `src/renderer/hooks/`

**Purpose:** Side-effect orchestration and lifecycle policies.
**Contains:** persistence loaders, updater/window hooks, terminal restore/autosave, file watching, browser integration.

### `src/renderer/lib/`

**Purpose:** Runtime adapter and service layer.
**Contains:** typed Tauri API wrappers for terminal, filesystem, browser, persistence, updater, dialog, window, clipboard, shell, and sessions.
**Integration:** Primary bridge from renderer to native runtime.

### `src/renderer/stores/`

**Purpose:** Global state domains.
**Contains:** project, workspace, terminal, editor, browser, annotation, snapshot, app-settings, updater, and related stores.

### `src/shared/types/`

**Purpose:** Shared contracts between renderer and runtime.
**Contains:** IPC result types, terminal/browser/persistence/session/window/updater contracts.

### `src-tauri/src/`

**Purpose:** Native runtime implementation.
**Contains:** Tauri setup, command handlers, PTY management, browser child webview management, migration logic, and trackers.
**Entry Points:** `main.rs`, `lib.rs`

### `src-tauri/src/pty/`

**Purpose:** Native terminal process subsystem.
**Contains:** spawn/write/resize/kill logic, Windows-specific ConPTY implementation.

### `src-tauri/src/trackers/`

**Purpose:** Terminal metadata observation subsystem.
**Contains:** current working directory tracker, git branch/status tracker, and exit code tracker.

### `.github/workflows/`

**Purpose:** CI/CD automation.
**Contains:** PR validation, release, packaging, monitoring, and review automation.

### `docs/`

**Purpose:** Project knowledge base and generated project documentation.
**Contains:** generated brownfield docs, operational documentation, scan reports, and verification notes.

## Entry Points

- **Renderer bootstrap (runtime-aware):** `src/renderer/main.tsx`
- **Renderer bootstrap (Tauri-only):** `src/renderer/tauri-main.tsx`
- **Browser/dev app root:** `src/renderer/App.tsx`
- **Desktop/Tauri app root:** `src/renderer/TauriApp.tsx`
- **Native binary entry:** `src-tauri/src/main.rs`
- **Tauri composition root:** `src-tauri/src/lib.rs`

## File Organization Patterns

### Feature Foldering in Components
The component tree is grouped by domain (`browser`, `editor`, `file-explorer`, `terminal`, `workspace`) with a separate `ui` primitive library.

### Store + Hook Pairing
Many domains have a store and one or more coordinating hooks, e.g. projects, snapshots, updater, editor persistence, command history.

### Adapter Isolation
Runtime-facing code is intentionally centralized in `src/renderer/lib/`, reducing direct native coupling in UI components.

### Native Manager Segmentation
The Rust side groups responsibilities into managers/subsystems rather than a single flat command implementation.

## Key File Types

### TypeScript / TSX
- **Pattern:** `src/**/*.ts`, `src/**/*.tsx`
- **Purpose:** Renderer logic, components, hooks, state stores, and shared contracts
- **Examples:** `WorkspaceLayout.tsx`, `workspace-store.ts`, `browser-api.ts`

### Rust
- **Pattern:** `src-tauri/src/**/*.rs`
- **Purpose:** Native runtime, commands, terminal/browser managers, tracking
- **Examples:** `lib.rs`, `commands.rs`, `pty/manager.rs`, `browser_tab_manager.rs`

### Configuration
- **Pattern:** `package.json`, `Cargo.toml`, `tauri.conf.json`, `vite.config*.ts`, `tailwind.config.ts`
- **Purpose:** build, packaging, runtime, and styling configuration

### Tests
- **Pattern:** `*.test.ts`, `*.test.tsx`, Rust `cargo test`
- **Purpose:** renderer component/hook/store coverage and native unit coverage

### GitHub Workflow YAML
- **Pattern:** `.github/workflows/*.yml`
- **Purpose:** validation and release automation

## Asset Locations

- **Static web assets:** `public/`
- **Documentation/screenshot assets:** `img/`
- **Native resources:** `src-tauri/resources/`
- **Application icons:** `src-tauri/icons/`

## Configuration Files

- `package.json` — scripts, JS dependencies, app metadata
- `src-tauri/Cargo.toml` — Rust package metadata and native dependencies
- `src-tauri/tauri.conf.json` — Tauri runtime/build/updater/window config
- `vite.config.ts` — default Vite build setup
- `vite.config.tauri.ts` — Tauri-specific frontend build config
- `tailwind.config.ts` — styling config
- `eslint.config.js` — linting rules
- `vitest.config.ts` — test runner config
- `components.json` — UI/component tooling metadata

## Development Notes

- `src/renderer/` is by far the largest code surface and contains most application behavior.
- The runtime boundary is explicit and important: UI code should prefer adapters from `src/renderer/lib/`.
- `src-tauri/resources/annotation-overlay.js` is important for browser annotation behavior and should be treated as part of the browser subsystem.
- The repository includes generated docs and operational notes in `docs/`, so not everything under `docs/` is hand-authored product documentation.

---

_Generated using BMAD Method `document-project` workflow_
