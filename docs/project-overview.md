# Termul Manager - Project Overview

**Date:** 2026-05-09
**Type:** Desktop Application
**Architecture:** Tauri desktop application with React renderer and Rust native runtime

## Executive Summary

Termul Manager is a project-aware desktop terminal workspace built on **Tauri 2**, with a **React 18 + TypeScript** frontend and a **Rust** backend runtime. The app organizes terminals by project, persists workspace state, supports snapshots and command history, and combines multiple interaction surfaces in a single desktop shell: terminal panes, file explorer, editor panels, and embedded browser tabs with annotation support.

The repository is a **single desktop application** rather than a multi-part monorepo. Its architecture separates concerns cleanly between:

- `src/renderer/` for UI, state, hooks, and runtime adapters
- `src/shared/` for shared TypeScript contracts
- `src-tauri/` for native windowing, PTY management, browser tab webviews, trackers, and migration infrastructure

## Project Classification

- **Repository Type:** Monolith
- **Project Type(s):** Desktop Application
- **Primary Language(s):** TypeScript, TSX, Rust
- **Architecture Pattern:** Layered desktop application with service adapters, state stores, and native command bridge

## Technology Stack Summary

| Category           | Technology                       | Version                          | Justification                                                                       |
| ------------------ | -------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| Desktop Runtime    | Tauri                            | 2.x                              | Native desktop shell, window management, plugin integration, updater support        |
| Native Backend     | Rust                             | edition 2021 / rust-version 1.77 | PTY lifecycle, browser webviews, migration manager, shell detection, OS integration |
| Frontend UI        | React                            | 18.3.1                           | Main renderer UI                                                                    |
| Language           | TypeScript                       | 5.8.3                            | Typed frontend codebase                                                             |
| Build Tool         | Vite                             | 5.4.19                           | Web asset build and dev server                                                      |
| Routing            | React Router                     | 6.30.1                           | Hash-based application routing                                                      |
| Async/Data         | TanStack React Query             | 5.83.0                           | Query client infrastructure                                                         |
| State Management   | Zustand                          | 5.0.9                            | App, workspace, terminal, editor, browser, and updater state                        |
| Styling            | Tailwind CSS                     | 3.4.17                           | Utility-first styling                                                               |
| UI Kit             | Radix UI + shadcn/ui             | mixed                            | Reusable UI primitives and wrappers                                                 |
| Terminal Rendering | xterm.js                         | 5.5.0                            | Terminal emulation in renderer                                                      |
| PTY Bridge         | tauri-pty + portable-pty         | mixed                            | Native PTY process management                                                       |
| Forms/Validation   | react-hook-form + zod            | 7.61.1 / 3.25.76                 | Input handling and schema validation                                                |
| Rich Text / Docs   | BlockNote + Mermaid + CodeMirror | mixed                            | Markdown, rich editing, diagrams, code editing                                      |
| Testing            | Vitest + Testing Library + jsdom | 4.0.16 / 16.3.1 / 27.4.0         | Renderer unit and integration tests                                                 |
| Quality            | ESLint                           | 9.32.0                           | Linting and CI validation                                                           |

## Key Features

- Project-based workspace organization
- Multiple terminal sessions with persistence and restore
- Pane-based workspace layout with terminal, browser, and editor tabs
- Embedded browser tabs backed by child webviews
- Annotation tooling for browser capture/export workflows
- File explorer and live file watching
- Command history and snapshot management
- Configurable keyboard shortcuts and preferences
- Auto-update infrastructure with signed artifacts
- Cross-platform packaging for Windows, Linux, and macOS

## Architecture Highlights

- **Dual renderer bootstrap:** browser-safe `App.tsx` and Tauri-first `TauriApp.tsx`
- **Runtime adapter layer:** `src/renderer/lib/` isolates Tauri-specific APIs from UI components
- **Store-driven UI:** Zustand stores model projects, terminals, workspace panes, editor tabs, browser sessions, updater state, and settings
- **Native command boundary:** Tauri commands in `src-tauri/src/commands.rs` expose PTY, browser tab, migration, and tracker capabilities through a consistent `IpcResult<T>` shape
- **Specialized native managers:** `PtyManager`, `BrowserTabManager`, `MigrationManager`, plus CWD/Git/exit-code trackers
- **Release discipline:** GitHub Actions validate lint/typecheck/tests/Rust checks and build signed updater artifacts

## Development Overview

### Prerequisites

- Bun 1.3+
- Rust toolchain (`rustup`, `cargo`, `rustc`)
- Platform-specific Tauri dependencies from the README

### Getting Started

Install dependencies with `bun install`, then run `bun run dev` to launch the Tauri app in development mode. The frontend is built with a Tauri-specific Vite config and served to the hidden startup window before the app shows itself.

### Key Commands

- **Install:** `bun install`
- **Dev:** `bun run dev`
- **Build:** `bun run build`
- **Test:** `bun run test`

## Repository Structure

The repository is centered around a single app root. The TypeScript renderer owns the interface and local interaction model, `src/shared` contains reusable contracts, and `src-tauri` holds native runtime capabilities, packaging metadata, and resources. Supporting docs live in `docs/`, while CI automation is defined in `.github/workflows/`.

## Documentation Map

For detailed information, see:

- [index.md](./index.md) - Master documentation index
- [architecture.md](./architecture.md) - Detailed architecture
- [source-tree-analysis.md](./source-tree-analysis.md) - Directory structure
- [development-guide.md](./development-guide.md) - Development workflow

---

_Generated using BMAD Method `document-project` workflow_
