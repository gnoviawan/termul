# Termul Manager - Architecture

**Date:** 2026-05-09
**Project Type:** Desktop Application
**Architecture Pattern:** Layered desktop application with renderer/runtime separation

## Executive Summary

Termul Manager is a single-repository desktop application built around a **Tauri 2 + Rust runtime** and a **React 18 + TypeScript renderer**. The architecture emphasizes a clean boundary between UI concerns and native capabilities:

- the **renderer** owns user interaction, state, layout orchestration, editor/browser/terminal surfaces, and persistence adapters
- the **native runtime** owns PTY processes, browser child webviews, migration execution, shell detection, window integration, and OS-level operations

The app behaves like a workspace shell rather than a single-purpose terminal view. It combines project switching, pane-based layout management, editor tabs, browser tabs, annotations, snapshots, command history, and updater flows in one desktop window.

## Technology Stack

| Category | Technology | Notes |
| --- | --- | --- |
| Desktop framework | Tauri 2 | Windowing, commands, plugin model, updater |
| Native language | Rust | Runtime managers, trackers, PTY, browser webviews |
| Frontend | React 18 + TypeScript | Main renderer UI |
| State | Zustand | App and feature stores |
| Styling | Tailwind CSS + Radix/shadcn | Design system and primitives |
| Terminal UI | xterm.js | In-renderer terminal rendering |
| PTY backend | portable-pty / tauri-pty | Native process-backed terminals |
| Build | Vite | Tauri dev/build integration |
| Testing | Vitest + Testing Library | Renderer validation |
| CI/CD | GitHub Actions | Validation, release, updater artifact publishing |

## High-Level Architecture

```text
User
  ↓
React Renderer (src/renderer)
  ├─ Layout shell
  ├─ Workspace panes/tabs
  ├─ Zustand stores
  ├─ Hooks/orchestration
  └─ Runtime adapter layer (src/renderer/lib)
        ↓
Tauri Command / Event Boundary
        ↓
Rust Runtime (src-tauri/src)
  ├─ PtyManager
  ├─ BrowserTabManager
  ├─ MigrationManager
  ├─ Trackers (cwd/git/exit code)
  └─ Window/menu/plugin integration
        ↓
OS / Filesystem / Shells / Child processes / Webviews
```

## Runtime Entry Points

### Renderer Entry Paths

There are two renderer bootstraps:

- `src/renderer/tauri-main.tsx` → always boots `TauriApp`
- `src/renderer/main.tsx` → chooses `TauriApp` or browser-safe `App` based on `__TAURI_INTERNALS__`

This preserves a browser/dev/test path while keeping the Tauri-specific app as the canonical desktop implementation.

### Native Entry Path

- `src-tauri/src/main.rs` initializes logging and delegates to `termul_manager_lib::run()`
- `src-tauri/src/lib.rs` builds the Tauri app, plugins, menu, managed state, migrations, and invoke handlers

## Renderer Architecture

### 1. App Shell Layer

Core shell files:

- `WorkspaceLayout.tsx`
- `TitleBar.tsx`
- `StatusBar.tsx`
- route pages such as `ProjectSettings.tsx`, `AppPreferences.tsx`, and `WorkspaceSnapshots.tsx`

Responsibilities:

- application frame and navigation
- global keyboard shortcuts
- modal orchestration
- project switching
- unsaved-change handling
- pane area + file explorer composition

### 2. Workspace/Pane Layer

The pane system is a major architectural pillar:

- `workspace-store.ts` models the pane tree
- `PaneRenderer.tsx` recursively renders split or leaf nodes
- `PaneContent.tsx` maps a leaf pane to terminal/editor/browser tab surfaces
- `WorkspaceTabBar.tsx` manages tab UX

This enables a flexible workspace model more like a lightweight IDE than a simple terminal multiplexer.

### 3. Feature Surface Layer

Each workspace surface is specialized:

- **Terminal:** `ConnectedTerminal.tsx`, xterm integration, PTY data/event binding
- **Editor:** `EditorPanel.tsx`, `CodeEditor.tsx`, `MarkdownEditor.tsx`
- **Browser:** `BrowserPanel.tsx`, annotation UI, embedded browser controls
- **File Explorer:** `FileExplorer.tsx` and node/context-menu helpers

### 4. Store Layer

Zustand stores define the main state domains:

- project store
- terminal store
- workspace store
- editor store
- browser session store
- annotation store
- snapshot store
- updater store
- app settings store
- context bar settings store
- sidebar/file explorer/recent command support stores

This is a strongly store-driven architecture with hooks providing side-effect orchestration.

### 5. Hook / Orchestration Layer

Hooks such as:

- `use-projects-persistence`
- `use-terminal-restore`
- `useTerminalAutoSave`
- `use-file-watcher`
- `use-updater`
- `use-window-state`
- `use-command-history`
- `use-snapshots`

coordinate side effects, persistence, restore behavior, event subscriptions, and lifecycle policies.

### 6. Adapter / API Layer

`src/renderer/lib/` isolates platform integration behind typed adapters such as:

- `terminal-api.ts`
- `filesystem-api.ts`
- `persistence-api.ts`
- `browser-api.ts`
- `window-api.ts`
- `shell-api.ts`
- updater/session/migration adapters

This is a key architectural boundary: components are expected to use adapters, not raw Tauri APIs.

## Native Runtime Architecture

### 1. App Builder / Composition Root

`src-tauri/src/lib.rs` acts as the composition root. It:

- builds menus
- registers plugins
- creates managed singletons
- runs startup migrations
- registers invoke handlers
- handles app shutdown cleanup for PTYs and browser tabs

### 2. Tauri Commands Layer

`src-tauri/src/commands.rs` exposes a typed command surface for:

- terminal spawn/write/resize/kill/query operations
- browser tab creation/navigation/show/hide/destroy and annotation actions
- migration/version/history/rollback operations

The command layer standardizes responses using an `IpcResult<T>` pattern.

### 3. PTY Subsystem

Core files:

- `src-tauri/src/pty/manager.rs`
- `src-tauri/src/pty/windows.rs`
- `src-tauri/src/pty/mod.rs`

Responsibilities:

- terminal slot limiting
- process spawn/kill/resize/write
- terminal lifecycle tracking
- Windows-specific ConPTY handling
- renderer attachment bookkeeping
- transcript / output event streaming
- orphan detection policies

### 4. Tracker Subsystem

`src-tauri/src/trackers/` contains:

- `cwd_tracker.rs`
- `git_tracker.rs`
- `exit_code_tracker.rs`

These monitor terminal-associated metadata and emit updates back to the renderer. The git tracker includes Windows-specific command resolution logic to avoid problematic PATH selections.

### 5. Browser Webview Subsystem

`browser_tab_manager.rs` manages child webviews and browser-tab lifecycle:

- create/destroy/show/hide child webviews
- navigate/reload/back/forward
- inject URL/title/load polling scripts
- inject/remove annotation overlays
- maintain tab metadata and selection state

This is one of the most custom parts of the app architecture.

### 6. Migration Subsystem

`migrations.rs` implements migration versioning/history/rollback scaffolding backed by Tauri store. Startup runs can fail the app if migration integrity fails.

## Data and Persistence Architecture

### Renderer-Side Persistence

The renderer uses Tauri plugin-store adapters through versioned persistence APIs.

Primary persisted domains include:

- projects
- terminal layouts
- snapshots
- command history
- window state
- app settings
- session persistence

### Shared Persistence Contracts

`src/shared/types/persistence.types.ts` defines structures like:

- `PersistedProjectData`
- `PersistedTerminalLayout`
- `PersistedSnapshotList`
- `WindowState`

### Notable Persistence Patterns

- debounced writes with flush-on-close behavior
- version-wrapped persisted records
- transcript/scrollback persistence for restore scenarios
- session store separated from general app data store

## State Management Patterns

### Project State
Tracks projects, active selection, archiving, colors, path, shell, and env vars.

### Terminal State
Tracks terminal records, PTY mapping, transcript accumulation, detached output, health, git/cwd/exit info, and hidden-state policies.

### Workspace State
Tracks the pane tree, active pane, active tabs, tab remapping, split/collapse behavior, and browser/editor/terminal tab helpers.

### Editor State
Tracks open file buffers, dirty state, view mode, cursor/scroll, save/reload transitions.

### Browser State
Tracks browser tabs, loading/title/nav state, annotation mode, and synchronization with runtime webviews.

## Browser Annotation Architecture

The annotation feature crosses multiple layers:

- browser session store for mode/state
- annotation store for persisted domain objects
- `BrowserPanel` and `AnnotationPanel` for UI
- `browser-api.ts` for IPC/event subscriptions
- `BrowserTabManager` for webview orchestration
- `src-tauri/resources/annotation-overlay.js` for in-page overlay injection

This is effectively a mini subsystem inside the app.

## Window / Menu / Updater Architecture

### Window Behavior
- custom title bar on Windows/Linux
- overlay-style native traffic lights on macOS
- hidden startup window shown once state is ready
- persisted window position/size/maximized state

### Menu Behavior
Native menu items include reload, zoom, full screen, updater trigger, and help link actions.

### Updater Behavior
The updater subsystem spans Tauri config, renderer store/hooks, and release workflow enforcement. Signed updater artifacts and manifest checks are required for stable releases.

## Testing Strategy

### Renderer
Vitest + Testing Library cover:

- components
- hooks
- stores
- adapter modules
- workspace interactions

### Native
CI runs:

- `cargo check --all-targets`
- `cargo test`
- `cargo clippy --all-targets -- -D warnings`

## Deployment / Release Architecture

- Tauri bundles are built for Windows, Linux, and macOS
- release workflow validates version parity across package/config manifests
- updater artifacts (`latest.json`, `.sig`) are required for stable publish
- signing keys are managed through GitHub secrets and documented operationally

## Strengths of the Current Architecture

- strong separation between renderer UI and native runtime capabilities
- well-defined typed IPC/result patterns
- broad feature coverage for a desktop productivity shell
- store-driven composition with reusable hooks
- good CI discipline across JS and Rust stacks
- significant test surface in renderer code

## Architectural Risks / Constraints

- terminal and pane rendering paths are performance-sensitive and complex
- browser annotation relies on injected scripts and webview timing behavior
- dual runtime/bootstrap paths require care when changing app initialization
- some legacy/transitional implementation surface remains in the renderer
- env var persistence includes a documented future security hardening gap for secrets

## Recommended Reading Order for Changes

### Terminal work
1. `src/renderer/components/terminal/ConnectedTerminal.tsx`
2. `src/renderer/stores/terminal-store.ts`
3. `src/renderer/lib/tauri-terminal-api.ts`
4. `src-tauri/src/commands.rs`
5. `src-tauri/src/pty/manager.rs`

### Browser/annotation work
1. `src/renderer/components/browser/BrowserPanel.tsx`
2. `src/renderer/stores/browser-session-store.ts`
3. `src/renderer/stores/annotation-store.ts`
4. `src/renderer/lib/browser-api.ts`
5. `src-tauri/src/browser_tab_manager.rs`
6. `src-tauri/resources/annotation-overlay.js`

### Workspace/layout work
1. `WorkspaceLayout.tsx`
2. `workspace-store.ts`
3. `PaneRenderer.tsx`
4. `PaneContent.tsx`
5. `WorkspaceTabBar.tsx`

---

_Generated using BMAD Method `document-project` workflow_
