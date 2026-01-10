# Termul Manager - Project Overview

> **Generated:** 2026-01-12
> **Version:** 0.1.0

---

## What is Termul Manager?

Termul Manager is a **project-aware terminal application** that treats workspaces as first-class citizens. Unlike traditional terminal emulators, Termul Manager organizes your terminal sessions by project, providing:

- **Project-based workspace organization** - Group terminals by project
- **Workspace snapshots** - Save and restore terminal states
- **Git integration** - Real-time branch and status tracking
- **Command palette** - Quick access to commands (Cmd+K)
- **Customizable shortcuts** - Define your own keybindings

---

## Quick Reference

| Attribute | Value |
|-----------|-------|
| **Name** | Termul Manager |
| **Type** | Desktop Application (Electron) |
| **Version** | 0.1.0 |
| **License** | MIT |
| **App ID** | com.termul-manager.app |

### Tech Stack Summary

| Layer | Technology |
|-------|------------|
| Framework | Electron 39 |
| Frontend | React 18 + TypeScript |
| State | Zustand |
| UI | Radix UI + Tailwind CSS |
| Terminal | node-pty + xterm.js |
| Build | Vite (electron-vite) |
| Testing | Vitest |

---

## Repository Structure

```
termul/
├── src/
│   ├── main/       # Electron main process
│   ├── preload/    # IPC bridge
│   ├── renderer/   # React UI
│   └── shared/     # Shared types
├── docs/           # Documentation
├── out/            # Build output
└── dist/           # Distribution packages
```

---

## Key Features

### 1. Project Workspaces
Organize terminals by project. Each project can have:
- Multiple terminal tabs
- Custom default shell
- Project-specific working directory
- Color coding for quick identification

### 2. Terminal Management
- Create, close, rename, and reorder terminals
- Shell selection (PowerShell, CMD, Git Bash, etc.)
- Real-time working directory tracking
- Exit code visibility

### 3. Git Integration
- Current branch display
- Change status (modified, staged, untracked)
- Real-time updates as you work

### 4. Workspace Snapshots
Save your entire workspace state:
- All projects and their configurations
- Terminal tabs and their scrollback
- Restore to any saved snapshot

### 5. Command Features
- Command palette (Cmd/Ctrl+K)
- Command history per terminal
- Recent commands quick access

---

## Getting Started

### Prerequisites
- Node.js 18+
- npm or bun

### Installation
```bash
# Clone the repository
git clone <repository-url>
cd termul

# Install dependencies
npm install

# Start development
npm run dev
```

### Building for Distribution
```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

---

## Documentation Index

- [Architecture Documentation](./architecture.md) - Technical architecture details
- [Source Tree Analysis](./source-tree-analysis.md) - Codebase structure
- [Development Guide](./development-guide.md) - Development setup and workflows
- [Component Inventory](./component-inventory.md) - UI component catalog

---

## For AI-Assisted Development

When working on this codebase with AI assistance:

1. **Entry Points:**
   - Main process: `src/main/index.ts`
   - Preload: `src/preload/index.ts`
   - Renderer: `src/renderer/main.tsx`

2. **Key Patterns:**
   - IPC uses typed `IpcResult<T>` pattern
   - State managed via Zustand stores
   - Components follow shadcn/ui conventions

3. **Adding Features:**
   - State: Add to or create a store in `stores/`
   - Native: Add IPC handler in `main/ipc/`
   - UI: Add component in `components/`
