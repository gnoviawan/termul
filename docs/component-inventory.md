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
- `StatusBar.tsx` — active project/terminal context bar showing git branch, git status, working directory, exit code, and updater state; rendered on the desktop layout only (the desktop app and the desktop-width web client), not on the mobile web shell, where connection health lives in the `MobileShellDrawer` footer
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
- `mobile/MobileChatShell.tsx` — narrow web shell: the header over the content (no bottom bar; the terminal key bar is the bottom edge on a terminal), the full-screen drawer and the header-opened sheets (project, Files, header ⋯, terminal ⋯). Hands the drawer the active tab's section to preselect and the attention count. Records the control that opened the drawer (☰ or the attention pill, with ☰ as the fallback) and the openers of its sheets in `lib/sheet-focus-return.ts`, the one focus-return mechanism, so focus returns there on close
- `mobile/MobileShellHeader.tsx` — shell header: ☰, title block (heading plus the project subtitle button), attention pill, ✎ and ⋯
- `mobile/MobileShellDrawer.tsx` — full-screen Claude-style drawer (full width, safe-area padded, built-in close; named "Termul", a visually hidden title on web): the project row as the top row beside the close (Tauri, with no project row, shows a small wordmark and title instead), one line of segmented section tabs (Chats with the attention badge, Terminals, Editors; a tap switches the list without closing; the active tab's section is preselected on each open and the list holds still while open), chat search (Chats only), one scrolling list (Chats: `MobileRecentsList`; Terminals and Editors: `MobileDrawerSectionList`; a row opens its tab and closes the drawer), and a pinned footer (Settings, Snapshots, Git history, the section's primary pill: New chat, New terminal or Browse files, labelled connection status). Owns drawer focus on open and, through `lib/sheet-focus-return.ts`, on close (the opener on a dismissal; on a navigation the open question's first option in the visible chat, else the shell title), and mounts the unread tracker
- `mobile/MobileRecentsList.tsx` — the drawer's Recents list: open chats merged into the scoped history (each chat once, open ones with live status glyphs shared with the desktop `agent-chat-tab` via `workspace/tabs/agent-chat-status.tsx`), grouped Today / Yesterday / Earlier, Claude-style rows with no trailing icons; a long-press or the focus-only row action opens `MobileRecentsActionsSheet` (Close for open chats, Delete behind the shared confirm for history)
- `mobile/MobileDrawerSectionList.tsx` — the drawer's Terminals list (rename, close) and Editors list (editor files, Git Changes, browser tabs), each row with its guarded close
- `mobile/MobileRecentsActionsSheet.tsx` — the Recents row actions bottom sheet
- `mobile/MobileHeaderMoreSheet.tsx` — header ⋯ bottom sheet for chats and tabs (Git changes, Files, Command palette, New terminal, Project settings, then Close chat for a chat or Close tab for other tabs such as Git History)
- `mobile/MobileTerminalActionsSheet.tsx` — terminal ⋯ bottom sheet (last exit code, rename, restart, command history, then Git changes, Files, Command palette and Project settings with the header sheet's gates, then close)
- `mobile/mobile-sheet-rows.ts` — the 44px action-row class, the destructive-row divider class and the shared navigation rows (Git changes, Files, Command palette, New terminal, Project settings) that both ⋯ sheets render from their callbacks
- `hooks/use-mobile-tab-actions.ts` / `hooks/use-mobile-section.ts` — the shared mobile select/close routing (fullscreen, route return, guarded closes) and the tab-kind to drawer-section mapping (`sectionForTab`, the drawer's preselect)
- `mobile/MobileTerminalControls.tsx` — touch-sized Esc/Tab/Ctrl+C/arrows/PgUp/PgDn and clipboard-paste accessory that writes standard terminal sequences. It also reports its top edge to the toast stack through `useDockClearance` (`hooks/use-dock-clearance.ts`), which publishes `--mobile-dock-height` so toasts clear the bar
- `TerminalTabBar.tsx` / `TerminalView.tsx` — legacy or transitional terminal view helpers retained in repository

### Editor Components

- `editor/EditorPanel.tsx` — selects code vs markdown editing mode and provides editor toolbar integration
- `editor/CodeEditor.tsx` — code editing surface
- `editor/MarkdownEditor.tsx` — BlockNote markdown editor with resizable table-of-contents side panel
- `editor/EditorToolbar.tsx` — markdown/code mode switching
- `editor/TableOfContents.tsx` and `editor/TocPanel.tsx` — heading navigation
- `editor/MermaidBlock.tsx` — diagram rendering for markdown workflows

### Agent Chat (ACP) Components

- `chat/AgentChatPanel.tsx` — top-level agent-chat pane body coordinating header, message thread, plan panel, permission dialog, and composer for a single ACP session
- `chat/ChatMessage.tsx` — user/agent message row; renders sanitized markdown prose plus media blocks as AI Elements `Attachments` grid thumbnails (lightbox for inline images, click-to-open for `file://`-backed blocks). On the mobile web shell (chosen by viewport size, not pointer type), a message that has a `MessageActions` row (every user message, and an agent turn tail) is focusable (`tabIndex={0}`), shows its row on keyboard focus (and on fine-pointer hover, never at rest), and opens a long-press / right-click / context-menu-key `ui/context-menu` (Copy · Edit or Copy · Retry) wired to the row's callbacks and the overlay stack (system back closes it). Other messages on that shell keep an inert menu wrapper so they do not remount when they gain or lose actions. Trade-offs of the whole-message trigger: no native long-press text selection on touch (partial copy goes through Copy, which copies the whole message, or the code-block / `ToolCallCard` copy buttons); no iOS link-preview or save-image callout inside these messages; and with a mouse in a narrow desktop window, right-click opens the message menu instead of the app-level Copy / Cut / Paste / Select All menu. Desktop is unchanged. Re-exports `AgentProse`, `TermulFilePathButton` and `TermulMarkdownImage` from `chat-agent-prose.tsx`
- `chat/ChatHistoryTab.tsx` — desktop sidebar chat history (recency groups, lazy window, row delete); exports `ChatDeleteConfirmDialog`, the delete confirm it shares with the mobile Recents list
- `chat/use-chat-history-entries.ts` — the chat history derivation both lists share: ADR 0002 scoping, query filter on the displayed title, settled-count announcement, lazy window, recency groups, open and delete (the caller names the delete log source)
- `chat/chat-agent-prose.tsx` — markdown renderer for agent replies (`AgentProse`) with the Streamdown plugin set, external-link confirm modal, inline `termul-image` and `termul-file-path` renderers; split out of `ChatMessage.tsx` to keep it under the file-size limit
- `chat/ChatInputBar.tsx` — composer with slash commands, `@`-file mentions, config/mode chips, and staged-attachment badges
- `chat/AttachmentPreviewGroup.tsx` — staged-attachment badges above the composer using AI Elements `Attachments` inline variant with hover-card image previews and click-to-open for path-backed refs
- `chat/use-composer-attachments.ts` — hybrid transport hook (OS picker → `resource_link`, drag/paste → inline image or embedded text) shared by the chat input and the new-thread launcher
- `chat/chat-attachments.ts` — attachment helpers: MIME guessing, name humanization, ACP block mapping, and `pendingToAttachmentData`/`blockToAttachmentData` adapters into AI Elements `AttachmentData`
- `ai-elements/attachments.tsx` — vendored [AI SDK Elements Attachments](https://elements.ai-sdk.dev/components/attachments) component (grid/inline/list variants) adapted to the repo's shadcn primitives and `ai` package types

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

### Git Components

- `git/GitPanel.tsx` — Git changes tab: staged and unstaged file lists, diff view, commit composer, branch switching and stashes. The mobile web shell stacks the file list and the diff view as one panel
- `git/GitHistoryPanel.tsx` — Git History tab: commit list with a lane graph, a filter field and a refresh button. The mobile web shell has its own branch in the same component: 44px two-line rows (subject over refs, author, time, short hash), 12px lanes, a full-width `text-base` filter and a 44px refresh button, with no commit-detail view

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

`terminal-api.ts` selects `tauri-terminal-api.ts` or `web-terminal-api.ts` at runtime. Renderer components, including `ConnectedTerminal` and mobile controls, never import Tauri APIs directly. The browser adapter owns `/terminal/ws` request correlation, listener fan-out, reconnect, and reattach behavior.
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
