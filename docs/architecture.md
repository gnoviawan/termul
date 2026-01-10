# Termul Manager - Architecture Documentation

> **Generated:** 2026-01-12
> **Project Type:** Desktop Application (Electron)
> **Version:** 0.1.0

---

## Executive Summary

Termul Manager is a project-aware terminal application built with Electron that treats workspaces as first-class citizens. It provides a modern terminal experience with project organization, workspace snapshots, and Git integration.

**Key Capabilities:**
- Multi-project workspace management
- Native terminal emulation via node-pty
- Real-time Git status and branch tracking
- Workspace snapshots for state preservation
- Customizable keyboard shortcuts
- Command history and palette

---

## Technology Stack

| Category | Technology | Version | Purpose |
|----------|------------|---------|---------|
| **Runtime** | Electron | 39.x | Desktop application framework |
| **Language** | TypeScript | 5.8.x | Type-safe JavaScript |
| **Frontend** | React | 18.3.x | UI framework |
| **Build Tool** | Vite (electron-vite) | 5.x | Fast bundler with HMR |
| **State Management** | Zustand | 5.x | Lightweight state management |
| **UI Library** | Radix UI | Various | Accessible component primitives |
| **Styling** | Tailwind CSS | 3.4.x | Utility-first CSS |
| **Terminal** | node-pty | 1.1.x | Native pseudo-terminal |
| **Testing** | Vitest | 4.x | Unit/integration testing |

---

## Architecture Pattern

### Electron 3-Process Architecture with Typed IPC Bridge

```
+-------------------------------------------------------------+
|                      MAIN PROCESS                           |
|  +-------------+ +-------------+ +---------------------+    |
|  | IPC Handlers| |  Services   | |    PTY Manager      |    |
|  | - terminal  | | - shell     | | - spawn terminals   |    |
|  | - dialog    | | - persist   | | - cwd tracking      |    |
|  | - shell     | | - window    | | - git tracking      |    |
|  | - persist   | | - cwd       | | - exit code track   |    |
|  | - system    | | - git       | +---------------------+    |
|  +-------------+ +-------------+                            |
+------------------------+------------------------------------+
                         | IPC (contextBridge)
+------------------------+------------------------------------+
|                     PRELOAD SCRIPT                          |
|  +-----------------------------------------------------+    |
|  | Typed API Bridge (window.api)                        |   |
|  | - terminalApi  - dialogApi  - shellApi              |    |
|  | - persistenceApi  - systemApi                        |   |
|  +-----------------------------------------------------+    |
+------------------------+------------------------------------+
                         | contextBridge
+------------------------+------------------------------------+
|                    RENDERER PROCESS                         |
|  +-----------+ +-----------+ +---------------------------+  |
|  |  Stores   | |   Pages   | |       Components          |  |
|  | - project | | - Dashboard| | - XTerminal              |  |
|  | - terminal| | - Settings| | - ProjectSidebar         |  |
|  | - settings| | - Snapshots| | - TerminalTabBar        |  |
|  | - commands| |           | | - CommandPalette         |  |
|  | - snapshot| |           | | - ui/* (shadcn)          |  |
|  +-----------+ +-----------+ +---------------------------+  |
+-------------------------------------------------------------+
```

---

## Process Responsibilities

### Main Process (`src/main/`)

The main process handles native operations and system integration:

**Entry Point:** `src/main/index.ts`

| Component | File | Responsibility |
|-----------|------|----------------|
| App Init | `index.ts` | Window creation, IPC registration |
| Terminal IPC | `ipc/terminal.ipc.ts` | PTY spawn, write, resize, kill |
| Dialog IPC | `ipc/dialog.ipc.ts` | Native file/directory dialogs |
| Shell IPC | `ipc/shell.ipc.ts` | Detect available shells |
| Persistence IPC | `ipc/persistence.ipc.ts` | JSON file read/write |
| System IPC | `ipc/system.ipc.ts` | System info (home directory) |

**Services:**

| Service | File | Purpose |
|---------|------|---------|
| PTY Manager | `services/pty-manager.ts` | Manage pseudo-terminal processes |
| CWD Tracker | `services/cwd-tracker.ts` | Track terminal working directory |
| Git Tracker | `services/git-tracker.ts` | Git branch and status detection |
| Exit Code Tracker | `services/exit-code-tracker.ts` | Track command exit codes |
| Persistence | `services/persistence-service.ts` | Debounced JSON file storage |
| Window State | `services/window-state.ts` | Window position/size persistence |
| Shell Detect | `services/shell-detect.ts` | Discover available shells |

### Preload Script (`src/preload/`)

Secure bridge between main and renderer processes:

**Entry Point:** `src/preload/index.ts`

Exposes typed APIs via `contextBridge`:

```typescript
window.api = {
  terminal: TerminalApi,    // Spawn, write, resize, kill, events
  dialog: DialogApi,        // File/directory selection
  shell: ShellApi,          // Available shells detection
  persistence: PersistenceApi, // JSON storage with debouncing
  system: SystemApi         // System information
}
```

### Renderer Process (`src/renderer/`)

React application for the user interface:

**Entry Point:** `src/renderer/main.tsx`

**Routing (HashRouter):**

| Path | Component | Purpose |
|------|-----------|---------|
| `/` | WorkspaceDashboard | Main terminal workspace |
| `/settings` | ProjectSettings | Project configuration |
| `/preferences` | AppPreferences | Global app preferences |
| `/snapshots` | WorkspaceSnapshots | Snapshot management |

---

## State Management

### Zustand Stores

| Store | Location | State | Purpose |
|-------|----------|-------|---------|
| `project-store` | `stores/project-store.ts` | projects, activeProjectId | Workspace management |
| `terminal-store` | `stores/terminal-store.ts` | terminals, activeTerminalId | Terminal instances |
| `app-settings-store` | `stores/app-settings-store.ts` | App preferences | Global settings |
| `keyboard-shortcuts-store` | `stores/keyboard-shortcuts-store.ts` | Keybindings | Custom shortcuts |
| `command-history-store` | `stores/command-history-store.ts` | Command history | Per-terminal history |
| `recent-commands-store` | `stores/recent-commands-store.ts` | Recent commands | Quick access |
| `snapshot-store` | `stores/snapshot-store.ts` | Snapshots | Workspace snapshots |
| `context-bar-settings-store` | `stores/context-bar-settings-store.ts` | UI settings | Context bar config |

### State Flow Pattern

```
User Action -> Store Action -> State Update -> React Re-render
                    |
                    v (if persistence needed)
              IPC Call -> Main Process -> File System
```

---

## IPC Communication

### Result Pattern

All IPC calls return a discriminated union for type-safe error handling:

```typescript
type IpcResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; code: string }
```

### IPC Channels

| Domain | Channels | Direction |
|--------|----------|-----------|
| Terminal | spawn, write, resize, kill, getCwd, getGitBranch, getGitStatus, getExitCode | Renderer -> Main |
| Terminal Events | data, exit, cwd-changed, git-branch-changed, git-status-changed, exit-code-changed | Main -> Renderer |
| Dialog | selectDirectory | Renderer -> Main |
| Shell | detect | Renderer -> Main |
| Persistence | read, write, writeDebounced, delete | Renderer -> Main |
| System | getHomeDirectory | Renderer -> Main |

---

## Component Architecture

### UI Component Categories

| Category | Count | Pattern |
|----------|-------|---------|
| shadcn/ui primitives | 45 | Radix UI + Tailwind |
| Terminal components | 4 | xterm.js integration |
| Feature components | 12 | App-specific features |
| Modal components | 5 | Dialog-based modals |

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `XTerminal` | `components/terminal/XTerminal.tsx` | xterm.js wrapper with WebGL |
| `ConnectedTerminal` | `components/terminal/ConnectedTerminal.tsx` | Terminal with IPC connection |
| `ProjectSidebar` | `components/ProjectSidebar.tsx` | Project navigation sidebar |
| `TerminalTabBar` | `components/TerminalTabBar.tsx` | Terminal tab management |
| `StatusBar` | `components/StatusBar.tsx` | Bottom status bar |
| `CommandPalette` | `components/CommandPalette.tsx` | Cmd+K command palette |

---

## Data Flow

### Terminal Data Flow

```
1. User types in terminal
2. XTerminal captures input
3. IPC: terminal:write(id, data)
4. PTY Manager writes to PTY
5. PTY output received
6. IPC: terminal:data event emitted
7. XTerminal displays output
```

### State Persistence Flow

```
1. State change in Zustand store
2. Hook (e.g., useProjectsAutoSave) detects change
3. IPC: persistence:writeDebounced(key, data)
4. PersistenceService debounces (500ms)
5. JSON file written to app data directory
```

---

## Security Model

### Context Isolation

- `contextIsolation: true` - Renderer cannot access Node.js
- `nodeIntegration: false` - No Node.js in renderer
- `sandbox: false` - Required for native modules (node-pty)

### Secure API Exposure

Only explicitly defined APIs are exposed via `contextBridge`:
- No direct access to `ipcRenderer`
- No access to filesystem from renderer
- All native operations go through typed handlers

---

## Testing Strategy

### Test Distribution

| Layer | Test Files | Framework |
|-------|------------|-----------|
| Main Process | 8 | Vitest |
| Renderer Stores | 8 | Vitest + JSDOM |
| Renderer Hooks | 5 | Vitest + Testing Library |
| Preload | 1 | Vitest |
| Components | 1+ | Vitest + Testing Library |

### Test Configuration

- **Environment:** JSDOM for renderer tests
- **Path Aliases:** `@` and `@renderer` mapped to `src/renderer`
- **Global Setup:** `vitest.setup.ts`

---

## Build & Deployment

### Build Targets

| Platform | Formats | Output |
|----------|---------|--------|
| Windows | NSIS, Portable | `dist/` |
| macOS | DMG, ZIP | `dist/` |
| Linux | AppImage, DEB | `dist/` |

### Build Process

```
npm run build:win   # Windows
npm run build:mac   # macOS
npm run build:linux # Linux
```

---

## File Structure Summary

```
src/
├── main/           # Electron main process
│   ├── index.ts    # Entry point
│   ├── ipc/        # IPC handlers
│   └── services/   # Business logic
├── preload/        # IPC bridge
│   └── index.ts    # API exposure
├── renderer/       # React UI
│   ├── components/ # UI components
│   ├── hooks/      # Custom hooks
│   ├── pages/      # Route pages
│   ├── stores/     # Zustand stores
│   └── types/      # Type definitions
└── shared/         # Shared types
    └── types/      # IPC contracts
```

---

## Next Steps for Development

1. **Adding New Features:**
   - Create store in `stores/` for state
   - Add IPC handler in `main/ipc/` if native access needed
   - Expose via preload if new API domain
   - Build UI in `components/`

2. **Adding New Terminal Features:**
   - Extend `PTYManager` for new capabilities
   - Add IPC channel in `terminal.ipc.ts`
   - Update `TerminalApi` interface in preload
   - Consume in `XTerminal` or `ConnectedTerminal`

3. **Testing New Code:**
   - Add `.test.ts` files alongside source
   - Run `npm test` for validation
