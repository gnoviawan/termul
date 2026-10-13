/**
 * Workspace store contract — extracted from ../workspace-store.ts. Pure move, no logic changes.
 */

import type { DropPosition, LeafNode, PaneDirection, PaneNode } from '@/types/workspace.types'

export type WorkspaceTab =
  | { type: 'terminal'; id: string; terminalId: string }
  | { type: 'editor'; id: string; filePath: string }
  | { type: 'browser'; id: string; browserTabId: string }
  | { type: 'git'; id: string; cwd: string }
  | {
      type: 'agent-chat'
      id: string
      sessionId: string
      /** Stable React mount identity — survives remapAgentChatSession so the chat panel is not remounted when the session id swaps. */
      mountKey?: string
    }
  | { type: 'git-history'; id: string; cwd: string }
  | {
      /** One file's staged or working-tree diff (CAP-9). The id is a stable hash of
       * the canonical identity (cwd, path, side); the tab keeps its stored `cwd`
       * and never resolves a working copy. */
      type: 'diff'
      id: string
      cwd: string
      path: string
      staged: boolean
    }
  | {
      /** OpenPencil canvas tab (singleton per project — AD-7): the id is a
       * deterministic function of the projectId, so repeat opens focus the
       * existing tab and a doc switch re-binds `docPath` in place. */
      type: 'canvas'
      id: string
      projectId: string
      docPath: string
    }

/** Options for `splitPane`. */
export interface SplitPaneOptions {
  /**
   * Split ratio as `[target pane share, new leaf share]`, normalized to sum
   * to 100. Defaults to `[50, 50]`; wrong-length, non-finite, or
   * non-positive values fall back to `[50, 50]` with a warn log. In a
   * same-direction flat group the shares split the target pane's former
   * extent instead of the whole grid.
   */
  sizes?: [number, number]
  /** Focus the newly created leaf (default true). */
  focus?: boolean
}

/** Options for `addTabToPane`. */
export interface AddTabOptions {
  /** Make the target pane the active pane (default true). */
  focus?: boolean
}

/**
 * One project's whole pane workspace: the five fields the store exposes flat
 * for the ACTIVE project. Parked (non-visible) projects keep exactly this
 * shape in `parkedTrees`, so switching moves object references and never
 * re-parses or clones a tree.
 */
export interface ProjectWorkspace {
  root: PaneNode
  activePaneId: string
  fullscreenPaneId: string | null
  /** Pane id where the agent launcher overlay is shown, or null to hide it. */
  agentLauncherPaneId: string | null
  /**
   * Pane id of the dedicated agent-browser pane (spec-acp-browser-automation-v2
   * CAP-3). Runtime-only state, never part of the persisted workspace
   * record; re-validated against the pane tree on every open.
   */
  agentBrowserPaneId: string | null
}

export interface WorkspaceState extends ProjectWorkspace {
  /**
   * The project whose tree is the flat fields above ('' until the first
   * commit by the project-switch coordinator). Persisted-state writers refuse
   * to write for any other project.
   */
  activeProjectId: string
  /** Trees of visited, non-active projects, keyed by project id. */
  parkedTrees: Record<string, ProjectWorkspace>
  /**
   * Make `projectId` the active project: park the current flat fields under
   * the previous active project (same object references), then load
   * `parkedTrees[projectId] ?? tree ?? a fresh single-leaf workspace`.
   */
  activateProject: (projectId: string, tree?: ProjectWorkspace) => void
  /** True when `projectId` is active or has a parked tree. */
  hasProjectTree: (projectId: string) => boolean
  /** The tree of an active or parked project (a snapshot of the flat fields when active). */
  getProjectTree: (projectId: string) => ProjectWorkspace | undefined
  /** Forget a parked tree (project deleted). The active tree is never dropped. */
  dropProjectTree: (projectId: string) => void
  showAgentLauncher: (paneId: string) => void
  hideAgentLauncher: () => void

  // Pane tree actions
  splitPane: (
    paneId: string,
    direction: PaneDirection,
    newTab: WorkspaceTab,
    position?: Exclude<DropPosition, 'center'>,
    options?: SplitPaneOptions
  ) => void
  addTabToPane: (paneId: string, tab: WorkspaceTab, options?: AddTabOptions) => void
  moveTabToPane: (tabId: string, sourcePaneId: string, targetPaneId: string) => void
  moveTabToNewSplit: (
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    position: DropPosition
  ) => void
  closeTab: (paneId: string, tabId: string) => WorkspaceTab | null
  setActiveTab: (paneId: string, tabId: string) => void
  setActivePane: (paneId: string) => void
  togglePaneFullscreen: (paneId: string) => void
  clearFullscreenPane: () => void
  updatePaneSizes: (splitId: string, sizes: number[]) => void
  collapsePane: (paneId: string) => void
  reorderTabsInPane: (paneId: string, orderedIds: string[]) => void

  // Legacy compat helpers — derived from tree
  getActiveTab: () => WorkspaceTab | undefined
  getActivePaneLeaf: () => LeafNode | null
  syncTerminalTabs: (terminalIds: string[]) => void
  clearEditorTabs: () => void
  clearPane: (paneId: string) => void
  resetLayout: () => void
  loadProjectWorkspace: (root: PaneNode, activePaneId?: string | null) => void
  syncEditorTabs: (filePaths: string[], activeTabId?: string | null) => void
  remapTerminalTabs: (idMap: Record<string, string>) => void

  // New tab helpers
  addTerminalTab: (terminalId: string, targetPaneId?: string) => void
  ensureTerminalTab: (terminalId: string, targetPaneId?: string, makeActive?: boolean) => void
  addEditorTab: (filePath: string, targetPaneId?: string) => void
  addBrowserTab: (browserTabId: string, targetPaneId?: string) => void
  /**
   * Open an agent-controlled browser tab in a dedicated right ~2/3 pane
   * (spec-acp-browser-automation-v2 CAP-3): reuse the tracked pane while it
   * still exists in the tree, otherwise split the active pane right with
   * sizes [33.3, 66.7] without moving focus off the chat pane. Exception:
   * when the tab is already open somewhere, current `addBrowserTab`
   * semantics apply — the existing tab is activated, which focuses its pane.
   */
  openAgentBrowserTab: (browserTabId: string, url?: string) => void
  addAgentChatTab: (sessionId: string, targetPaneId?: string) => void
  /** Put an Agent chat tab back without focusing it or changing the route. */
  insertAgentChatTab: (sessionId: string) => void
  /**
   * Open (or activate) the Git Changes tab for `cwd`. Reuse-by-(type, cwd):
   * repeated calls activate the existing tab instead of minting
   * `git-${randomUUID()}` duplicates (QA: rail button 4 clicks → 4 tabs).
   */
  addGitTab: (cwd: string, targetPaneId?: string) => void
  /**
   * Open (or activate) the Git History tab for `cwd`, same reuse semantics.
   */
  addGitHistoryTab: (cwd: string, targetPaneId?: string) => void
  /**
   * Open (or focus) the Diff tab for one file side. Identity is the canonical
   * `(cwd, path, staged)` triple (`diffTabId`); a repeat open focuses the
   * existing tab in whichever pane holds it, else the tab joins the target (or
   * active) pane. No UI caller yet: the Changes-panel opener is a later story.
   */
  addDiffTab: (cwd: string, path: string, staged: boolean, targetPaneId?: string) => void
  /**
   * Open (or activate) the project's canvas tab (OpenPencil canvas mode,
   * AD-7 singleton-per-project): the tab id is a deterministic function of
   * the projectId, so a repeat open focuses the one existing tab regardless
   * of the doc, and opening a different `.op` re-binds `docPath` in place
   * (the pool releases the old doc's daemon and acquires the new one; the
   * iframe navigates to the new embed URL).
   */
  addCanvasTab: (projectId: string, docPath: string, targetPaneId?: string) => void
  /**
   * Swap a launch-placeholder chat tab to the real ACP session id without
   * leaving a duplicate tab behind.
   */
  remapAgentChatSession: (fromSessionId: string, toSessionId: string, targetPaneId?: string) => void
  removeTab: (tabId: string) => void
  getNextTabId: (direction: 1 | -1) => string | null
}
