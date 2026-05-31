# Termul Manager - Development Guide

**Date:** 2026-05-09

## Overview

Termul Manager is developed as a Tauri-first desktop application. Day-to-day development primarily happens in the TypeScript renderer while native desktop runtime concerns live in the Rust `src-tauri/` workspace.

## Prerequisites

### Core Tooling

- Bun 1.3+
- Rust toolchain (`rustup`, `cargo`, `rustc`)
- Git

### Platform Requirements

#### Windows

- Visual Studio 2022 / MSVC build tools
- WebView2 runtime

#### macOS

- Xcode Command Line Tools
- Rust toolchain

#### Linux

Install the WebKitGTK and Tauri build dependencies documented in `README.md`.

## Install

```bash
bun install
```

## Local Development

### Start the App

```bash
bun run dev
```

This launches the Tauri app and uses the Tauri-specific Vite configuration to serve `tauri-index.html` to the hidden startup window before the app is shown.

### Browser-Oriented Preview Path

The repository also retains a browser/dev bootstrap path (`index.html` -> `src/renderer/main.tsx` -> `App.tsx`) for preview, testing, and non-Tauri-safe fallbacks.

## Build Commands

### Standard Production Build

```bash
bun run build
```

### Frontend-Only Tauri Asset Build

```bash
bun run build:frontend:tauri
```

### Debug / Targeted Tauri Builds

```bash
bun run build:tauri:debug
bun run build:tauri:win
bun run build:tauri:mac-arm
bun run build:tauri:mac-x64
bun run build:tauri:linux
```

## Quality Checks

### Lint

```bash
bun run lint
```

### Typecheck

```bash
bun run typecheck
```

### Tests

```bash
bun run test
bun run test:watch
```

### Direct Tauri CLI Access

```bash
bun run tauri <command>
```

## Source Layout

### Frontend

- `src/renderer/components/` — UI components
- `src/renderer/hooks/` — orchestration and lifecycle hooks
- `src/renderer/stores/` — Zustand state domains
- `src/renderer/lib/` — API adapters and runtime helpers
- `src/renderer/pages/` — route-level screens
- `src/renderer/layouts/` — app-level layout shells

### Shared Contracts

- `src/shared/types/` — shared TS types for IPC, persistence, filesystem, updater data

### Native Runtime

- `src-tauri/src/` — Rust runtime modules
- `src-tauri/resources/` — injected browser resources such as `annotation-overlay.js`
- `src-tauri/icons/` — app icons and platform packaging assets
- `src-tauri/tauri.conf.json` / `tauri.conf.prod.json` — runtime/build configuration

## Development Workflows

### Working on Renderer Features

Typical renderer changes involve:

1. Updating UI components in `src/renderer/components/`
2. Adjusting state logic in one or more Zustand stores
3. Using `@/lib/api` adapters rather than calling Tauri APIs directly from presentation components
4. Adding Vitest/Testing Library coverage near the affected files

### Working on Native Features

Typical native/runtime changes involve:

1. Implementing or updating a Rust manager/module in `src-tauri/src/`
2. Exposing commands via `src-tauri/src/commands.rs`
3. Updating shared contracts in `src/shared/types/ipc.types.ts` or related files
4. Wiring renderer adapters under `src/renderer/lib/`

### Terminal-Related Changes

Terminal behavior crosses several layers:

- Rust PTY management in `src-tauri/src/pty/`
- IPC command handlers in `src-tauri/src/commands.rs`
- Renderer adapters in `src/renderer/lib/tauri-terminal-api.ts` and `src/renderer/lib/api.ts`
- UI behavior in `src/renderer/components/terminal/ConnectedTerminal.tsx`
- persisted terminal/session structures in `src/shared/types/persistence.types.ts`

### Browser/Annotation Changes

Browser tab work spans:

- `src-tauri/src/browser_tab_manager.rs`
- browser commands in `commands.rs`
- `src/renderer/lib/browser-api.ts`
- `src/renderer/components/browser/*`
- annotation stores/hooks and the injected overlay resource

## Persistence and Local Data

The app stores local state using Tauri plugin store adapters:

- `termul-data.json` — general app persistence
- `termul-sessions.json` — session persistence
- logical keys like `projects`, `terminals/{projectId}`, `snapshots/{projectId}`, `window-state`

Project env vars are persisted in local store data, but secret-marked values are redacted before persistence and must be re-entered after app restart until secure OS storage is added.

## File Watching and Editor Behavior

The file explorer and editor support live file watching through the filesystem API. Changed files can auto-refresh when clean, or prompt the user when buffers are dirty.

## CI and Validation

### Pull Requests

`.github/workflows/pr-validation.yml` runs:

- PR title conventional-commit validation
- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `cargo check --all-targets`
- `cargo test`
- `cargo clippy --all-targets -- -D warnings`
- frontend Tauri build verification

### Releases

`.github/workflows/release.yml`:

- generates changelog entries
- validates version alignment across `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`
- builds platform artifacts
- verifies updater artifacts like `latest.json` and `.sig`
- publishes the release

## Contribution Conventions

From `CONTRIBUTING.md`:

- Use TypeScript for new frontend code
- Follow existing patterns
- Keep components focused and single-purpose
- Write tests for new functionality
- Place tests next to the code they cover
- Use conventional commits (`feat:`, `fix:`, `docs:`, etc.)

## Common Risks / Gotchas

- Tauri and browser-safe code paths both exist; be careful which runtime path you are modifying.
- Terminal rendering and workspace pane logic are performance-sensitive and heavily optimized.
- Browser annotation behavior depends on injected scripts and webview lifecycle timing.
- Auto-update, signing, and release version alignment are strict and CI-enforced.
- Some persistence/session logic uses debounced writes, so shutdown/close flows explicitly flush pending writes.

## Recommended Local Verification Before PR

```bash
bun run lint
bun run typecheck
bun run test
cd src-tauri && cargo check --all-targets && cargo test
```

If changing release/update behavior, also review:

- `docs/auto-update-release-verification.md`
- `.github/workflows/release.yml`
- `src-tauri/tauri.conf.json`

---

_Generated using BMAD Method `document-project` workflow_
