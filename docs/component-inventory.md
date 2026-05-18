# Termul Manager - Component Inventory

**Date:** 2026-05-09
**Project Type:** Desktop Application

## Overview

The renderer is component-driven and organized around a workspace shell that hosts three primary interactive surfaces:

- **Terminal experience** powered by xterm.js and PTY-backed runtime APIs
- **Editor experience** for code and markdown files
- **Browser experience** using child webviews and annotation tooling

Supporting these are shared layout, navigation, modal, and design-system components.

## Component Categories

### Layout and Shell

- `TitleBar.tsx` — custom desktop title bar with sidebar/file explorer toggles, settings navigation, and native window controls
- `StatusBar.tsx` — active project/terminal context bar showing git branch, git status, working directory, exit code, and updater state
- `ProjectSidebar.tsx` — project switcher, reorderable workspace list, archive/restore flows, rename/color operations, shell discovery hooks
- `WorkspaceLayout.tsx` — top-level application shell coordinating sidebar, pane area, file explorer, modals, keyboard shortcuts, and close workflows

### Workspace / Pane System

- `workspace/PaneRenderer.tsx` — recursive pane renderer for split layouts
- `workspace/PaneContent.tsx` — content host for terminal, editor, and browser tabs inside a leaf pane
- `workspace/WorkspaceTabBar.tsx` — tab strip for workspace tabs, reordering, terminal/editor/browser tab controls
- `workspace/EditorTab.tsx` — editor tab presentation
- `workspace/DropZoneOverlay.tsx` — drag/drop affordance for split and tab interactions

### Terminal Components

- `terminal/ConnectedTerminal.tsx` — production terminal surface integrating xterm, PTY lifecycle, clipboard, fit, WebGL, scrollback replay, and shortcut passthrough
- `terminal/XTerminal.tsx` — xterm-focused rendering support
- `terminal/TauriTerminal.tsx` — alternate direct Tauri PTY terminal implementation
- `terminal/TerminalSearchBar.tsx` — terminal text search UI
- `terminal/ActivityIndicator.tsx` — recent terminal activity indicator
- `TerminalTabBar.tsx` / `TerminalView.tsx` — legacy or transitional terminal view helpers retained in repository

### Editor Components

- `editor/EditorPanel.tsx` — selects code vs markdown editing mode and provides editor toolbar integration
- `editor/CodeEditor.tsx` — code editing surface
- `editor/MarkdownEditor.tsx` — BlockNote markdown editor with resizable table-of-contents side panel
- `editor/EditorToolbar.tsx` — markdown/code mode switching
- `editor/TableOfContents.tsx` and `editor/TocPanel.tsx` — heading navigation
- `editor/MermaidBlock.tsx` — diagram rendering for markdown workflows

### Browser / Annotation Components

- `browser/BrowserPanel.tsx` — pane host for embedded browser webview state and annotation workflow
- `browser/BrowserControls.tsx` — navigation controls and URL interactions
- `browser/AnnotationPanel.tsx` — review UI for captured annotations, severity/intent labeling, and export flows
- `browser/AnnotationExportModal.tsx` — export packaging for annotations

### File Explorer Components

- `file-explorer/FileExplorer.tsx` — project file tree shell, selection model, inline creation/rename, clipboard operations, and editor opening
- `file-explorer/FileTreeNode.tsx` — recursive node renderer
- `file-explorer/FileTreeContextMenu.tsx` — context actions for files and directories
- `file-explorer/file-icon-map.ts` — icon mapping support

### Workspace Actions / Modal Components

- `CommandPalette.tsx` — global command launcher for project switching and workspace actions
- `CommandHistoryModal.tsx` — per-project and aggregate command history viewer
- `NewProjectModal.tsx` — create project workflow
- `CreateSnapshotModal.tsx` / `RestoreSnapshotModal.tsx` / `DeleteSnapshotModal.tsx` — snapshot lifecycle UI
- `ConfirmDialog.tsx` — reusable confirmation dialog used by close/discard/delete workflows
- `ContextMenu.tsx` — reusable custom context menu shell
- `ShellSelector.tsx` — shell selection UX
- `ShortcutRecorder.tsx` — keyboard shortcut recording
- `ColorPickerPopover.tsx` / `ContextBarSettingsPopover.tsx` — settings micro-interactions
- `UpdateAvailableToast.tsx` / `UpdateReadyModal.tsx` — updater UX

### Error Handling

- `ErrorBoundary.tsx` — runtime error boundary for major UI regions
- `ErrorFallback.tsx` — user-facing fallback content

### UI Primitive Library

The `components/ui/` directory contains a large set of shadcn/Radix-style primitives such as dialogs, menus, tabs, select, tooltip, toast, resizable panels, drawers, forms, sheets, tables, and related foundation components.

## State-Backed UI Domains

These components are coordinated by dedicated Zustand stores:

- `project-store.ts` — projects and active selection
- `terminal-store.ts` — PTY mapping, transcripts, exit status, activity, hidden-state management
- `workspace-store.ts` — pane tree, active tabs, split layout logic
- `editor-store.ts` — open file buffers, dirty state, save/reload lifecycle
- `browser-session-store.ts` — browser tabs, loading, title, navigation state, annotation mode
- `annotation-store.ts` — annotation data model and export concerns
- `snapshot-store.ts` — workspace snapshots
- `app-settings-store.ts` — terminal/UI preferences
- `context-bar-settings-store.ts` — status bar visibility preferences
- `updater-store.ts` — updater lifecycle and download/install state

## Design Patterns

### 1. Shell + Feature Surface Pattern
The app shell (`WorkspaceLayout`) owns cross-cutting concerns, while feature surfaces (`ConnectedTerminal`, `EditorPanel`, `BrowserPanel`) encapsulate mode-specific behavior.

### 2. Adapter Isolation Pattern
UI components prefer `@/lib/api` adapters rather than direct Tauri APIs, keeping runtime coupling isolated in a service layer.

### 3. Store-Driven Rendering
Most interactive components derive state from focused selectors into Zustand stores, reducing prop-drilling and separating orchestration from presentation.

### 4. Multi-Tab Polymorphism
Workspace tabs are modeled as three tab types:

- terminal
- editor
- browser

The pane renderer switches among them while reusing one pane and tab framework.

## Reusable UI Highlights

- Generic confirmation dialogs
- Shared command palette structure
- Shared context menu system
- Shared resizable-pane primitives
- Shared tooltip/toast infrastructure
- Shared tab/pane DnD affordances

## Testing Coverage

The component layer has broad renderer test coverage, including tests for:

- terminal components
- browser annotation components
- file explorer behavior
- workspace tab rendering
- status/title bar interactions
- modals and popovers

## Notes for Future Work

- `TerminalView.tsx` and `TauriTerminal.tsx` appear to coexist with the more integrated `ConnectedTerminal.tsx`, indicating some retained transitional/legacy implementation surface.
- The browser annotation workflow is a major differentiated feature and deserves special attention when changing browser tab or overlay behavior.
- Pane and terminal rendering are performance-sensitive; several files include optimizations and render-isolation strategies.

---

_Generated using BMAD Method `document-project` workflow_
