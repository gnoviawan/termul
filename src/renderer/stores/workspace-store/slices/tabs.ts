/**
 * Tab-opener slice — extracted from ../../workspace-store.ts. Pure move, no logic changes.
 */

import type { StateCreator } from 'zustand'
import { logFrontendError } from '@/lib/log-api'
import { navigateToChatSession } from '@/lib/router-navigate'
import {
  AGENT_BROWSER_SPLIT_SIZES,
  agentChatTabId,
  canvasTabId,
  editorTabId,
  findPaneById,
  findPaneContainingTab,
  getAllLeafPanes,
  gitHistoryTabId,
  gitTabId,
  makeBrowserTabId,
  resolveActivePaneId,
  terminalTabId,
  updateLeaf
} from '../tree'
import type { WorkspaceState, WorkspaceTab } from '../types'

type TabsSliceState = Pick<
  WorkspaceState,
  | 'addTerminalTab'
  | 'ensureTerminalTab'
  | 'addEditorTab'
  | 'addBrowserTab'
  | 'openAgentBrowserTab'
  | 'addAgentChatTab'
  | 'insertAgentChatTab'
  | 'addGitTab'
  | 'addGitHistoryTab'
  | 'addCanvasTab'
  | 'remapAgentChatSession'
  | 'removeTab'
>

export const createTabsSlice: StateCreator<WorkspaceState, [], [], TabsSliceState> = (
  set,
  get
) => ({
  addTerminalTab: (terminalId: string, targetPaneId?: string): void => {
    const id = terminalTabId(terminalId)
    const { root, activePaneId, agentLauncherPaneId } = get()
    const paneId = targetPaneId ?? activePaneId

    // Check if already exists in any pane
    const existing = findPaneContainingTab(root, id)
    if (existing) {
      // Just activate it
      const { fullscreenPaneId } = get()
      set({
        root: updateLeaf(root, existing.id, (l) => ({ ...l, activeTabId: id })),
        activePaneId: resolveActivePaneId(fullscreenPaneId, existing.id),
        agentLauncherPaneId: agentLauncherPaneId === existing.id ? null : agentLauncherPaneId
      })
      return
    }

    const tab: WorkspaceTab = { type: 'terminal', id, terminalId }
    get().addTabToPane(paneId, tab)
  },

  ensureTerminalTab: (
    terminalId: string,
    targetPaneId?: string,
    makeActive: boolean = false
  ): void => {
    const id = terminalTabId(terminalId)
    const { root, activePaneId } = get()
    const paneId = targetPaneId ?? activePaneId
    const existing = findPaneContainingTab(root, id)

    if (existing) {
      return
    }

    const tab: WorkspaceTab = { type: 'terminal', id, terminalId }
    if (makeActive) {
      get().addTabToPane(paneId, tab)
      return
    }

    const pane = findPaneById(root, paneId)
    if (pane?.type !== 'leaf') {
      return
    }

    const newRoot = updateLeaf(root, paneId, (leaf) => ({
      ...leaf,
      tabs: [...leaf.tabs, tab]
    }))
    set({ root: newRoot })
  },

  addEditorTab: (filePath: string, targetPaneId?: string): void => {
    const id = editorTabId(filePath)
    const { root, activePaneId, agentLauncherPaneId } = get()
    const paneId = targetPaneId ?? activePaneId

    // Check if already exists in target pane — activate it
    const targetPane = findPaneById(root, paneId)
    if (targetPane && targetPane.type === 'leaf' && targetPane.tabs.some((t) => t.id === id)) {
      const { fullscreenPaneId } = get()
      set({
        root: updateLeaf(root, paneId, (l) => ({ ...l, activeTabId: id })),
        activePaneId: resolveActivePaneId(fullscreenPaneId, paneId),
        agentLauncherPaneId: agentLauncherPaneId === paneId ? null : agentLauncherPaneId
      })
      return
    }

    const tab: WorkspaceTab = { type: 'editor', id, filePath }
    get().addTabToPane(paneId, tab)
  },

  addBrowserTab: (browserTabId: string, targetPaneId?: string): void => {
    const id = makeBrowserTabId(browserTabId)
    const { root, activePaneId, agentLauncherPaneId } = get()
    const paneId = targetPaneId ?? activePaneId

    // Check if already exists in any pane — activate it
    const existing = findPaneContainingTab(root, id)
    if (existing) {
      const { fullscreenPaneId } = get()
      set({
        root: updateLeaf(root, existing.id, (l) => ({ ...l, activeTabId: id })),
        activePaneId: resolveActivePaneId(fullscreenPaneId, existing.id),
        agentLauncherPaneId: agentLauncherPaneId === existing.id ? null : agentLauncherPaneId
      })
      return
    }

    const tab: WorkspaceTab = { type: 'browser', id, browserTabId }
    get().addTabToPane(paneId, tab)
  },

  openAgentBrowserTab: (browserTabId: string, _url?: string): void => {
    const id = makeBrowserTabId(browserTabId)
    const { root, activePaneId, agentBrowserPaneId } = get()

    // Only the fullscreen pane renders while one is active, so an agent
    // tab placed anywhere else would never mount (its browser_tab_create
    // would never fire and the host's open waiter would time out). Clear
    // fullscreen whenever the hosting pane is not the fullscreen pane —
    // tabs stay visible by design.
    const ensureVisible = (hostingPaneId: string): void => {
      const { fullscreenPaneId: fullscreen } = get()
      if (fullscreen !== null && fullscreen !== hostingPaneId) {
        get().clearFullscreenPane()
      }
    }

    // Tab already open in some pane: current addBrowserTab semantics —
    // activate it in place instead of minting a duplicate.
    const existingPane = findPaneContainingTab(root, id)
    if (existingPane) {
      ensureVisible(existingPane.id)
      get().addBrowserTab(browserTabId)
      return
    }

    const tab: WorkspaceTab = { type: 'browser', id, browserTabId }

    // Reuse the dedicated agent-browser pane while it still lives in the tree.
    const dedicated = agentBrowserPaneId !== null ? findPaneById(root, agentBrowserPaneId) : null
    if (dedicated?.type === 'leaf') {
      ensureVisible(dedicated.id)
      get().addTabToPane(dedicated.id, tab, { focus: false })
      return
    }

    // First open (or the dedicated pane was closed): split the active pane
    // right ~[33.3, 66.7] without moving focus off the chat pane. When the
    // active pane is missing or not a leaf (splitPane would silently
    // no-op), fall back to the first leaf so the tab still mounts — the
    // host's pending open waiter resolves on mount.
    const activePane = findPaneById(root, activePaneId)
    const splitTargetId = activePane?.type === 'leaf' ? activePaneId : getAllLeafPanes(root)[0]?.id
    if (splitTargetId !== undefined) {
      get().splitPane(splitTargetId, 'horizontal', tab, 'right', {
        sizes: AGENT_BROWSER_SPLIT_SIZES,
        focus: false
      })
    }
    const newLeaf = findPaneContainingTab(get().root, id)
    if (newLeaf) {
      ensureVisible(newLeaf.id)
      set({ agentBrowserPaneId: newLeaf.id })
      return
    }
    // No leaf pane accepted the tab: the host's open waiter would hang —
    // leave a durable failure trace for field diagnosis.
    void logFrontendError({
      level: 'error',
      message: `[workspace] agent browser tab could not be placed: no leaf pane accepted the split (tabId=${browserTabId})`,
      source: 'workspace-store:openAgentBrowserTab'
    })
  },

  addAgentChatTab: (sessionId: string, targetPaneId?: string): void => {
    const id = agentChatTabId(sessionId)
    const { root, activePaneId, agentLauncherPaneId, fullscreenPaneId } = get()
    const paneId = targetPaneId ?? activePaneId

    navigateToChatSession(sessionId)

    const existing = findPaneContainingTab(root, id)
    if (existing) {
      // Idempotent no-op (multi-project perf): when the chat tab already
      // exists, is its pane's active tab, AND the workspace already shows
      // exactly that state (focused pane, no fullscreen pane stealing
      // focus, no launcher over the pane), the activation set() below
      // would only rebuild the identical pane tree — every
      // WorkspaceLayout → PaneContent → WorkspaceTabBar subtree would
      // re-render for nothing. `activePaneId` is part of the guard: the
      // activation set() also refocuses the chat's pane, so an
      // already-active chat in an unfocused pane must still run
      // (sidebar/list re-open relies on it). Route re-entry (ChatRoute)
      // delegates here unconditionally — this guard is the single
      // idempotency predicate; repeated clicks on the already-active,
      // focused chat tab land here.
      const activationIsNoop =
        existing.activeTabId === id &&
        activePaneId === resolveActivePaneId(fullscreenPaneId, existing.id) &&
        (agentLauncherPaneId === null || agentLauncherPaneId !== existing.id)
      if (activationIsNoop) return
      set({
        root: updateLeaf(root, existing.id, (l) => ({ ...l, activeTabId: id })),
        activePaneId: resolveActivePaneId(fullscreenPaneId, existing.id),
        agentLauncherPaneId: agentLauncherPaneId === existing.id ? null : agentLauncherPaneId
      })
      return
    }

    const tab: WorkspaceTab = { type: 'agent-chat', id, sessionId, mountKey: id }
    get().addTabToPane(paneId, tab)
  },

  insertAgentChatTab: (sessionId: string): void => {
    const id = agentChatTabId(sessionId)
    const { root, activePaneId } = get()
    if (findPaneContainingTab(root, id)) return
    const pane = findPaneById(root, activePaneId)
    if (pane?.type !== 'leaf') return
    const tab: WorkspaceTab = { type: 'agent-chat', id, sessionId, mountKey: id }
    set({
      root: updateLeaf(root, pane.id, (leaf) => ({
        ...leaf,
        tabs: [...leaf.tabs, tab],
        activeTabId: leaf.activeTabId ?? tab.id
      }))
    })
  },

  // Reuse-by-(type, cwd) helpers. The tab id is a deterministic function of
  // the cwd, so `findPaneContainingTab` activation (the addBrowserTab
  // pattern) collapses repeated opens into the one existing tab — 4 rail
  // clicks yield 1 Git Changes tab, activated.
  addGitTab: (cwd: string, targetPaneId?: string): void => {
    const id = gitTabId(cwd)
    const { root, activePaneId, agentLauncherPaneId } = get()
    const paneId = targetPaneId ?? activePaneId

    const existing = findPaneContainingTab(root, id)
    if (existing) {
      const { fullscreenPaneId } = get()
      set({
        root: updateLeaf(root, existing.id, (l) => ({ ...l, activeTabId: id })),
        activePaneId: resolveActivePaneId(fullscreenPaneId, existing.id),
        agentLauncherPaneId: agentLauncherPaneId === existing.id ? null : agentLauncherPaneId
      })
      return
    }

    const tab: WorkspaceTab = { type: 'git', id, cwd }
    get().addTabToPane(paneId, tab)
  },

  addGitHistoryTab: (cwd: string, targetPaneId?: string): void => {
    const id = gitHistoryTabId(cwd)
    const { root, activePaneId, agentLauncherPaneId } = get()
    const paneId = targetPaneId ?? activePaneId

    const existing = findPaneContainingTab(root, id)
    if (existing) {
      const { fullscreenPaneId } = get()
      set({
        root: updateLeaf(root, existing.id, (l) => ({ ...l, activeTabId: id })),
        activePaneId: resolveActivePaneId(fullscreenPaneId, existing.id),
        agentLauncherPaneId: agentLauncherPaneId === existing.id ? null : agentLauncherPaneId
      })
      return
    }

    const tab: WorkspaceTab = { type: 'git-history', id, cwd }
    get().addTabToPane(paneId, tab)
  },

  // Canvas singleton-per-project (AD-7): the tab id is derived from the
  // projectId (NOT the doc), so repeated opens — same doc or not — collapse
  // onto the one existing canvas tab (the addGitTab activation pattern),
  // and a different docPath re-binds the same tab in place.
  addCanvasTab: (projectId: string, docPath: string, targetPaneId?: string): void => {
    const id = canvasTabId(projectId)
    const { root, activePaneId, agentLauncherPaneId } = get()
    const paneId = targetPaneId ?? activePaneId

    const existing = findPaneContainingTab(root, id)
    if (existing) {
      const { fullscreenPaneId } = get()
      set({
        root: updateLeaf(root, existing.id, (l) => ({
          ...l,
          activeTabId: id,
          tabs: l.tabs.map((tab) =>
            tab.id === id && tab.type === 'canvas' ? { ...tab, docPath } : tab
          )
        })),
        activePaneId: resolveActivePaneId(fullscreenPaneId, existing.id),
        agentLauncherPaneId: agentLauncherPaneId === existing.id ? null : agentLauncherPaneId
      })
      return
    }

    const tab: WorkspaceTab = { type: 'canvas', id, projectId, docPath }
    get().addTabToPane(paneId, tab)
  },

  remapAgentChatSession: (fromSessionId, toSessionId, targetPaneId?: string): void => {
    if (fromSessionId === toSessionId) {
      get().addAgentChatTab(toSessionId, targetPaneId)
      return
    }
    const fromId = agentChatTabId(fromSessionId)
    const toId = agentChatTabId(toSessionId)
    const { root, agentLauncherPaneId } = get()
    const pane = findPaneContainingTab(root, fromId)
    if (!pane) {
      get().addAgentChatTab(toSessionId, targetPaneId)
      return
    }
    const { fullscreenPaneId } = get()
    const nextRoot = updateLeaf(root, pane.id, (leaf) => {
      const tabs = leaf.tabs
        // Drop a pre-existing destination tab before the swap so the
        // remapped source (which carries the stable mountKey) is the sole
        // survivor regardless of tab order.
        .filter((tab) => !(tab.type === 'agent-chat' && tab.id === toId))
        .map((tab) => {
          if (tab.id !== fromId || tab.type !== 'agent-chat') return tab
          return {
            type: 'agent-chat' as const,
            id: toId,
            sessionId: toSessionId,
            mountKey: tab.mountKey ?? tab.id
          }
        })
      return {
        ...leaf,
        tabs,
        activeTabId: leaf.activeTabId === fromId ? toId : leaf.activeTabId
      }
    })
    set({
      root: nextRoot,
      activePaneId: resolveActivePaneId(fullscreenPaneId, pane.id),
      agentLauncherPaneId: agentLauncherPaneId === pane.id ? null : agentLauncherPaneId
    })
    navigateToChatSession(toSessionId)
  },

  removeTab: (tabId: string): void => {
    const { root } = get()
    const pane = findPaneContainingTab(root, tabId)
    if (pane) {
      void get().closeTab(pane.id, tabId)
    }
  }
})
