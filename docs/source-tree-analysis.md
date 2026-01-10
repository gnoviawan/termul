# Termul Manager - Source Tree Analysis

> **Generated:** 2026-01-12

---

## Directory Structure

```
termul/
├── .claude/                    # Claude Code configuration
├── .github/
│   └── agents/                 # BMAD agent configurations (10 files)
├── _bmad/                      # BMAD workflow system
├── _bmad-output/               # BMAD planning artifacts output
├── dist/                       # Electron builder output (installers)
├── docs/                       # Generated documentation
├── node_modules/               # Dependencies
├── out/                        # Vite build output
│   ├── main/                   # Compiled main process
│   ├── preload/                # Compiled preload scripts
│   └── renderer/               # Compiled renderer (React app)
├── public/                     # Static assets for renderer
├── resources/                  # App resources (icons, etc.)
├── src/                        # SOURCE CODE
│   ├── main/                   # Electron main process
│   ├── preload/                # IPC bridge
│   ├── renderer/               # React frontend
│   └── shared/                 # Shared types
├── electron.vite.config.ts     # Vite config for Electron
├── tailwind.config.ts          # Tailwind CSS config
├── tsconfig.json               # TypeScript root config
├── tsconfig.node.json          # TS config for main/preload
├── tsconfig.web.json           # TS config for renderer
├── vitest.config.ts            # Test configuration
└── package.json                # Dependencies & scripts
```

---

## Source Code Structure

### Main Process (`src/main/`)

The Electron main process handling native operations.

```
src/main/
├── index.ts                    # ★ ENTRY POINT - App initialization
├── index.test.ts               # Entry point tests
├── ipc/                        # IPC Handlers
│   ├── dialog.ipc.ts           # File/directory dialog handlers
│   ├── persistence.ipc.ts      # JSON file storage handlers
│   ├── shell.ipc.ts            # Shell detection handlers
│   ├── system.ipc.ts           # System info handlers
│   ├── terminal.ipc.ts         # Terminal spawn/control handlers
│   └── terminal.ipc.test.ts    # Terminal IPC tests
└── services/                   # Business Logic Services
    ├── cwd-tracker.ts          # Track terminal working directory
    ├── cwd-tracker.test.ts
    ├── exit-code-tracker.ts    # Track command exit codes
    ├── exit-code-tracker.test.ts
    ├── git-tracker.ts          # Git branch/status detection
    ├── git-tracker.test.ts
    ├── persistence-service.ts  # Debounced JSON file storage
    ├── persistence-service.test.ts
    ├── pty-manager.ts          # PTY process management
    ├── pty-manager.test.ts
    ├── shell-detect.ts         # Discover available shells
    ├── shell-detect.test.ts
    ├── window-state.ts         # Window position/size persistence
    └── window-state.test.ts
```

### Preload Script (`src/preload/`)

Secure IPC bridge between main and renderer.

```
src/preload/
├── index.ts                    # ★ API BRIDGE - contextBridge exposure
├── index.d.ts                  # Type declarations for window.api
└── index.test.ts               # Preload tests
```

### Renderer Process (`src/renderer/`)

React application for the user interface.

```
src/renderer/
├── main.tsx                    # ★ REACT ENTRY POINT
├── App.tsx                     # Root component + routing + effects
├── App.test.tsx                # App tests
├── components/                 # UI Components
│   ├── ui/                     # shadcn/ui primitives (45 components)
│   │   ├── accordion.tsx
│   │   ├── alert-dialog.tsx
│   │   ├── button.tsx
│   │   ├── dialog.tsx
│   │   ├── dropdown-menu.tsx
│   │   ├── tabs.tsx
│   │   ├── toast.tsx
│   │   └── ... (38 more)
│   ├── terminal/               # Terminal-specific components
│   │   ├── XTerminal.tsx       # xterm.js wrapper
│   │   ├── XTerminal.test.tsx
│   │   ├── ConnectedTerminal.tsx # Terminal with IPC
│   │   ├── ConnectedTerminal.test.tsx
│   │   └── TerminalSearchBar.tsx
│   ├── ProjectSidebar.tsx      # Project navigation sidebar
│   ├── ProjectSidebar.test.tsx
│   ├── TerminalTabBar.tsx      # Terminal tab management
│   ├── StatusBar.tsx           # Bottom status bar
│   ├── StatusBar.test.tsx
│   ├── CommandPalette.tsx      # Cmd+K command palette
│   ├── CommandHistoryModal.tsx # Command history viewer
│   ├── ConfirmDialog.tsx       # Confirmation dialogs
│   ├── ConfirmDialog.test.tsx
│   ├── ColorPickerPopover.tsx  # Color selection
│   ├── ColorPickerPopover.test.tsx
│   ├── ContextMenu.tsx         # Right-click context menu
│   ├── ContextMenu.test.tsx
│   ├── ContextBarSettingsPopover.tsx
│   ├── CreateSnapshotModal.tsx # Snapshot creation
│   ├── RestoreSnapshotModal.tsx # Snapshot restoration
│   ├── DeleteSnapshotModal.tsx # Snapshot deletion
│   ├── NewProjectModal.tsx     # Project creation
│   ├── ShellSelector.tsx       # Shell selection dropdown
│   ├── ShortcutRecorder.tsx    # Keyboard shortcut recorder
│   ├── NavLink.tsx             # Navigation links
│   └── TerminalView.tsx        # Terminal view container
├── hooks/                      # Custom React Hooks (21 hooks)
│   ├── use-toast.ts            # Toast notifications
│   ├── use-terminal-resize.ts  # Terminal resize handling
│   ├── use-terminal-resize.test.ts
│   ├── use-xterm.ts            # xterm.js instance management
│   ├── use-xterm.test.ts
│   ├── useTerminals.ts         # Terminal state access
│   ├── useTerminalAutoSave.ts  # Auto-save terminal state
│   ├── useTerminalAutoSave.test.ts
│   ├── use-terminal-restore.ts # Restore terminal state
│   ├── use-cwd.ts              # CWD tracking hook
│   ├── use-cwd.test.ts
│   ├── use-git-branch.ts       # Git branch tracking
│   ├── use-git-status.ts       # Git status tracking
│   ├── use-exit-code.ts        # Exit code tracking
│   ├── use-context-bar-settings.ts
│   ├── use-snapshots.ts        # Snapshot management
│   ├── use-recent-commands.ts  # Recent commands
│   ├── use-command-history.ts  # Command history
│   ├── use-app-settings.ts     # App settings loader
│   ├── use-keyboard-shortcuts.ts # Keyboard shortcuts loader
│   ├── use-projects-persistence.ts # Project persistence
│   └── use-mobile.tsx          # Mobile detection
├── lib/                        # Utility Libraries
│   └── utils.ts                # Common utilities (cn, etc.)
├── pages/                      # Route Pages
│   ├── WorkspaceDashboard.tsx  # Main terminal workspace
│   ├── WorkspaceDashboard.test.tsx
│   ├── ProjectSettings.tsx     # Project configuration
│   ├── AppPreferences.tsx      # Global app preferences
│   ├── WorkspaceSnapshots.tsx  # Snapshot management
│   └── NotFound.tsx            # 404 page
├── stores/                     # Zustand State Stores (8 stores)
│   ├── index.ts                # Store exports
│   ├── project-store.ts        # Project/workspace state
│   ├── project-store.test.ts
│   ├── terminal-store.ts       # Terminal instance state
│   ├── terminal-store.test.ts
│   ├── app-settings-store.ts   # App preferences state
│   ├── app-settings-store.test.ts
│   ├── keyboard-shortcuts-store.ts # Keybindings state
│   ├── keyboard-shortcuts-store.test.ts
│   ├── command-history-store.ts # Command history state
│   ├── command-history-store.test.ts
│   ├── recent-commands-store.ts # Recent commands state
│   ├── recent-commands-store.test.ts
│   ├── snapshot-store.ts       # Snapshot state
│   ├── snapshot-store.test.ts
│   ├── context-bar-settings-store.ts
│   └── context-bar-settings-store.test.ts
├── types/                      # TypeScript Type Definitions
│   ├── project.ts              # Project and terminal types
│   └── settings.ts             # Settings types
└── utils/                      # Utility Functions
    ├── terminal-registry.ts    # Terminal instance registry
    └── terminal-registry.test.ts
```

### Shared Types (`src/shared/`)

Types shared between main and renderer processes.

```
src/shared/
└── types/
    ├── ipc.types.ts            # IPC contract types (Result, APIs)
    └── persistence.types.ts    # Storage schema types
```

---

## Critical Files

| File | Purpose | Importance |
|------|---------|------------|
| `src/main/index.ts` | App initialization | Entry point |
| `src/preload/index.ts` | IPC API bridge | Security boundary |
| `src/renderer/main.tsx` | React mount | UI entry |
| `src/renderer/App.tsx` | Root component | Routing + effects |
| `src/shared/types/ipc.types.ts` | IPC contracts | Type safety |
| `src/main/services/pty-manager.ts` | PTY handling | Core feature |
| `src/renderer/stores/project-store.ts` | Project state | Data model |
| `src/renderer/stores/terminal-store.ts` | Terminal state | Data model |

---

## Configuration Files

| File | Purpose |
|------|---------|
| `package.json` | Dependencies, scripts, electron-builder config |
| `electron.vite.config.ts` | Vite configuration for Electron |
| `tsconfig.json` | TypeScript root configuration |
| `tsconfig.node.json` | TS config for main/preload |
| `tsconfig.web.json` | TS config for renderer |
| `tailwind.config.ts` | Tailwind CSS configuration |
| `vitest.config.ts` | Test framework configuration |
| `eslint.config.js` | Linting rules |
| `components.json` | shadcn/ui configuration |
