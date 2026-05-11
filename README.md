<div align="center">

# 🖥️ Termul Manager

**A modern, project-aware terminal manager built with Tauri**

Termul treats workspaces as first-class citizens, allowing you to organize terminals by project with persistent sessions, snapshots, and a clean tabbed interface.

[![GitHub Stars](https://img.shields.io/github/stars/gnoviawan/termul?style=social)](https://github.com/gnoviawan/termul/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/gnoviawan/termul)](https://github.com/gnoviawan/termul/issues)
[![License](https://img.shields.io/github/license/gnoviawan/termul)](LICENSE)
[![Latest Release](https://img.shields.io/github/v/release/gnoviawan/termul?include_prereleases)](https://github.com/gnoviawan/termul/releases)

[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](https://github.com/gnoviawan/termul)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

[Getting Started](#-getting-started) · [Features](#-features) · [Documentation](#-documentation) · [Contributing](CONTRIBUTING.md) · [Report Bug](https://github.com/gnoviawan/termul/issues/new?template=bug_report.md) · [Request Feature](https://github.com/gnoviawan/termul/issues/new?template=feature_request.md)

</div>

---

## ✨ Features

### 🪟 Workspace & Terminal Management

| Feature | Description |
|---------|-------------|
| **Project-Based Workspaces** | Organize terminals by project with dedicated workspace directories, separate state, and per-project configuration |
| **Pane-Based Split Layout** | Split your workspace into resizable panes and arrange terminals, editors, and browser tabs side by side |
| **Tabbed Interface** | Windows Terminal-style tab bar with drag-and-drop reordering, rename, and context menu |
| **Multiple Shell Support** | Auto-detects PowerShell, CMD, Git Bash, WSL, fish, zsh, and more; switch shells per tab |

### 📝 Editor & File Management

| Feature | Description |
|---------|-------------|
| **Code Editor** | Built-in code editor with syntax highlighting, file buffers, dirty-state tracking, and save/reload |
| **Markdown Editor** | Rich markdown editing powered by BlockNote with live preview, table of contents, and heading navigation |
| **Mermaid Diagrams** | Render Mermaid diagrams inline within your markdown documents |
| **File Explorer** | Full file tree with create, rename, delete, clipboard operations, drag-and-drop, and context menus |
| **File Watching** | Live file watching for real-time updates as files change on disk |

### 🌐 Browser & Annotation

| Feature | Description |
|---------|-------------|
| **Embedded Browser Tabs** | Browse the web directly inside your workspace using child webview tabs — no app switching |
| **Annotation Workflow** | Capture browser states, annotate with severity and intent labels, review, and export |
| **Annotation Export** | Package annotations with metadata into structured export formats |

### ⚡ Power User Tools

| Feature | Description |
|---------|-------------|
| **Command Palette** | Global command launcher (`Ctrl+K` / `Ctrl+Shift+P`) for project switching, workspace actions, and more |
| **Command History** | Per-project and aggregate command history viewer with search |
| **Keyboard Shortcuts** | Fully customizable shortcut bindings for every action |
| **Git Integration** | Status bar shows current branch, working directory, git status, and exit code |
| **Custom Title Bar** | Desktop-native title bar with window controls, sidebar toggles, and settings navigation |

### 🔧 System & Reliability

| Feature | Description |
|---------|-------------|
| **Auto-Updater** | Built-in update infrastructure with signed artifacts — get notified and update without leaving the app |
| **State Management** | Zustand-powered reactive stores for projects, terminals, workspace layout, editor buffers, browser sessions, and settings |
| **Configurable Settings** | Terminal and UI preferences, color picker, theme customization, and shell configuration |
| **Cross-Platform** | Works on Windows, macOS, and Linux with native platform packaging |
| **Error Boundaries** | Graceful error handling with runtime error boundaries and user-friendly fallback UI |

<details>
<summary>🗺️ Feature Map — Component Overview</summary>

| Domain | Key Components | Zustand Store |
|--------|---------------|---------------|
| **Workspace** | `WorkspaceLayout`, `PaneRenderer`, `PaneContent`, `WorkspaceTabBar` | `workspace-store` |
| **Terminal** | `ConnectedTerminal`, `XTerminal`, `TerminalSearchBar`, `ActivityIndicator` | `terminal-store` |
| **Editor** | `EditorPanel`, `CodeEditor`, `MarkdownEditor`, `EditorToolbar`, `MermaidBlock` | `editor-store` |
| **Browser** | `BrowserPanel`, `BrowserControls`, `AnnotationPanel`, `AnnotationExportModal` | `browser-session-store`, `annotation-store` |
| **File Explorer** | `FileExplorer`, `FileTreeNode`, `FileTreeContextMenu` | — |
| **Snapshots** | `CreateSnapshotModal`, `RestoreSnapshotModal`, `DeleteSnapshotModal` | `snapshot-store` |
| **Projects** | `ProjectSidebar`, `NewProjectModal` | `project-store` |
| **Settings** | `ShortcutRecorder`, `ColorPickerPopover`, `ContextBarSettingsPopover` | `app-settings-store`, `context-bar-settings-store` |
| **Updates** | `UpdateAvailableToast`, `UpdateReadyModal` | `updater-store` |
| **Shared** | `CommandPalette`, `ContextMenu`, `ConfirmDialog`, `ShellSelector`, `ErrorBoundary` | — |

</details>

## 📸 Screenshots

![Termul Manager Screenshot](img/termul.png)

## 🚀 Getting Started

### Prerequisites

| Dependency | Version | Notes |
| ---------- | ------- | ----- |
| [Node.js](https://nodejs.org) | 18+ | Recommended: use [nvm](https://github.com/nvm-sh/nvm) |
| [Rust](https://www.rust-lang.org/tools/install) | Latest stable | Required for Tauri builds |
| npm / bun | Any | Package manager |

#### Platform-Specific Requirements

<details>
<summary>Windows</summary>

- Microsoft Visual C++ Build Tools (included in Visual Studio 2022)
- [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on Windows 10+)

</details>

<details>
<summary>macOS</summary>

```bash
xcode-select --install
```

</details>

<details>
<summary>Linux (Debian/Ubuntu)</summary>

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev \
    build-essential curl wget file \
    libxdo-dev libssl-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev patchelf
```

</details>

<details>
<summary>Linux (Fedora)</summary>

```bash
sudo dnf install webkit2gtk4.1-devel \
    gcc gcc-c++ libopenssl-devel \
    appindicator-devel librsvg2-devel \
    patchelf
```

</details>

### Install Rust Toolchain

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustc --version && cargo --version
```

### Quick Start

```bash
# Clone the repository
git clone https://github.com/gnoviawan/termul.git
cd termul

# Install dependencies
npm install

# Launch in development mode
npm run dev
```

### Building for Production

```bash
# Build for your current platform
npm run build

# Platform-specific builds
npm run build:tauri:win        # Windows (x64)
npm run build:tauri:mac-arm    # macOS (Apple Silicon)
npm run build:tauri:mac-x64    # macOS (Intel)
npm run build:tauri:linux      # Linux (x64)

# Debug build (faster compilation, larger binary)
npm run build:tauri:debug
```

Build output: `src-tauri/target/release/bundle/`

## 📖 Documentation

### Usage

#### Creating a Project

1. Click the **+** button in the sidebar to create a new project
2. Select a workspace directory
3. Configure your default shell (optional)

#### Terminal Tabs

| Action | How |
| ------ | --- |
| New terminal | Click **+** next to tabs |
| Select specific shell | Click the dropdown arrow |
| Reorder tabs | Drag and drop |
| Rename tab | Double-click the tab |
| Context menu | Right-click (rename, close, kill process) |

#### Keyboard Shortcuts

| Action | Default Shortcut |
| ------ | ---------------- |
| New Terminal | `Ctrl+T` |
| Next Tab | `Ctrl+PageDown` |
| Previous Tab | `Ctrl+PageUp` |
| Command Palette | `Ctrl+K` / `Ctrl+Shift+P` |

> Shortcuts are customizable in Settings. On Tauri/WebView2, browser-reserved shortcuts such as `Ctrl+Tab` are not used as defaults because they are not reliably interceptable.

### Architecture

#### Tech Stack

| Layer | Technology |
| ----- | ---------- |
| Desktop Runtime | [Tauri 2.0](https://tauri.app) |
| Backend | [Rust](https://www.rust-lang.org) |
| UI Framework | [React 18](https://react.dev) |
| Type System | [TypeScript](https://www.typescriptlang.org) |
| Build Tool | [Vite](https://vitejs.dev) |
| Styling | [Tailwind CSS](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com) |
| State Management | [Zustand](https://zustand-demo.pmnd.rs) |
| Terminal Emulation | [tauri-pty](https://github.com/nicegram/tauri-pty) + [xterm.js](https://xtermjs.org) |
| Animations | [Framer Motion](https://www.framer.com/motion) |

#### Tauri Plugins

| Plugin | Purpose |
| ------ | ------- |
| `@tauri-apps/plugin-fs` | Filesystem access |
| `@tauri-apps/plugin-store` | Configuration persistence |
| `@tauri-apps/plugin-os` | OS information |
| `@tauri-apps/plugin-dialog` | Native dialogs |
| `@tauri-apps/plugin-clipboard-manager` | Clipboard operations |
| `@tauri-apps/plugin-updater` | Automatic updates |
| `@tauri-apps/plugin-process` | Process management |

#### Project Structure

```text
src/
├── renderer/           # React frontend
│   ├── components/     # UI components
│   ├── hooks/          # Custom React hooks
│   ├── lib/            # Runtime adapters & desktop integration
│   ├── pages/          # Page components
│   └── stores/         # Zustand stores
├── shared/             # Shared types (main/renderer)
src-tauri/              # Rust backend, config & bundling
docs/electron-old/      # Archived Electron docs & migration history
```

#### Platform Adapters

The renderer uses an adapter/service layer to keep desktop integrations isolated from UI code:

```text
src/renderer/lib/
├── tauri-*.ts        # Tauri-native integrations
├── *.ts              # Runtime-safe facades & helpers
└── __tests__/        # Regression & parity coverage
```

## 🛠️ Development

```bash
npm run dev              # Development mode with hot reload
npm test                 # Run tests
npm run test:watch       # Tests in watch mode
npm run typecheck        # Type checking
npm run lint             # Linting
npm run tauri <command>  # Direct Tauri CLI access
```

## ⭐ Star History

[![Star History Chart](img/star-history.svg)](https://star-history.com/#gnoviawan/termul&Date)

## 🤝 Contributing

Contributions are welcome! Please read the [Contributing Guide](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Windows Terminal](https://github.com/microsoft/terminal) — Tab bar UX inspiration
- [Hyper](https://github.com/vercel/hyper) — Extensible terminal design inspiration
- [xterm.js](https://github.com/xtermjs/xterm.js) — Terminal rendering
- [shadcn/ui](https://ui.shadcn.com/) — UI components
- [Tauri](https://tauri.app/) — Desktop app framework

---

<div align="center">

Built with ❤️ by [gnoviawan](https://github.com/gnoviawan)

</div>
