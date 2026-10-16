/**
 * Selector hooks and tree-derived getters — extracted from ../workspace-store.ts.
 * Pure move, no logic changes.
 */

import { useShallow } from 'zustand/shallow'
import type { PaneNode } from '@/types/workspace.types'
import { useWorkspaceStore } from './index'
import { usePaneTree } from './pane-context'
import { findPaneById, getAllLeafPanes } from './tree'
import type { WorkspaceState, WorkspaceTab } from './types'

// Selector hooks
export function useWorkspaceTabs(): WorkspaceTab[] {
  // Returns tabs of the active pane
  return useWorkspaceStore(
    useShallow((state) => {
      const pane = findPaneById(state.root, state.activePaneId)
      if (pane?.type !== 'leaf') return []
      return pane.tabs
    })
  )
}

export function useActiveTab(): WorkspaceTab | undefined {
  return useWorkspaceStore((state) => {
    const pane = findPaneById(state.root, state.activePaneId)
    if (pane?.type !== 'leaf') return undefined
    return pane.tabs.find((t) => t.id === pane.activeTabId)
  })
}

export function useActiveTabId(): string | null {
  return useWorkspaceStore((state) => {
    const pane = findPaneById(state.root, state.activePaneId)
    if (pane?.type !== 'leaf') return null
    return pane.activeTabId
  })
}

export function useActivePaneId(): string {
  return usePaneTree((tree) => tree.activePaneId)
}

export function useFullscreenPaneId(): string | null {
  return usePaneTree((tree) => tree.fullscreenPaneId)
}

export function useLeafCount(): number {
  return usePaneTree((tree) => getAllLeafPanes(tree.root).length)
}

export function usePaneRoot(): PaneNode {
  return useWorkspaceStore((state) => state.root)
}

export function useWorkspaceActions(): Pick<
  WorkspaceState,
  | 'addTerminalTab'
  | 'addEditorTab'
  | 'addBrowserTab'
  | 'addAgentChatTab'
  | 'addGitTab'
  | 'addGitHistoryTab'
  | 'addCommitDiffTab'
  | 'addDiffTab'
  | 'addCanvasTab'
  | 'removeTab'
  | 'setActiveTab'
  | 'reorderTabsInPane'
  | 'syncTerminalTabs'
  | 'clearEditorTabs'
  | 'clearPane'
  | 'showAgentLauncher'
  | 'hideAgentLauncher'
  | 'syncEditorTabs'
  | 'getNextTabId'
  | 'splitPane'
  | 'addTabToPane'
  | 'moveTabToPane'
  | 'moveTabToNewSplit'
  | 'closeTab'
  | 'setActivePane'
  | 'togglePaneFullscreen'
  | 'clearFullscreenPane'
  | 'collapsePane'
  | 'updatePaneSizes'
> {
  return useWorkspaceStore(
    useShallow((state) => ({
      addTerminalTab: state.addTerminalTab,
      addEditorTab: state.addEditorTab,
      addBrowserTab: state.addBrowserTab,
      addAgentChatTab: state.addAgentChatTab,
      addGitTab: state.addGitTab,
      addGitHistoryTab: state.addGitHistoryTab,
      addCommitDiffTab: state.addCommitDiffTab,
      addDiffTab: state.addDiffTab,
      addCanvasTab: state.addCanvasTab,
      removeTab: state.removeTab,
      setActiveTab: state.setActiveTab,
      reorderTabsInPane: state.reorderTabsInPane,
      syncTerminalTabs: state.syncTerminalTabs,
      clearEditorTabs: state.clearEditorTabs,
      clearPane: state.clearPane,
      showAgentLauncher: state.showAgentLauncher,
      hideAgentLauncher: state.hideAgentLauncher,
      syncEditorTabs: state.syncEditorTabs,
      getNextTabId: state.getNextTabId,
      splitPane: state.splitPane,
      addTabToPane: state.addTabToPane,
      moveTabToPane: state.moveTabToPane,
      moveTabToNewSplit: state.moveTabToNewSplit,
      closeTab: state.closeTab,
      setActivePane: state.setActivePane,
      togglePaneFullscreen: state.togglePaneFullscreen,
      clearFullscreenPane: state.clearFullscreenPane,
      collapsePane: state.collapsePane,
      updatePaneSizes: state.updatePaneSizes
    }))
  )
}

// Derive active terminal/editor from pane tree (source of truth)
export function getActiveTerminalIdFromTree(state: WorkspaceState): string | null {
  const pane = findPaneById(state.root, state.activePaneId)
  if (pane?.type !== 'leaf') return null
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId)
  if (activeTab?.type === 'terminal') return activeTab.terminalId
  return null
}

export function getActiveFilePathFromTree(state: WorkspaceState): string | null {
  const pane = findPaneById(state.root, state.activePaneId)
  if (pane?.type !== 'leaf') return null
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId)
  if (activeTab?.type === 'editor') return activeTab.filePath
  return null
}

/** Roots of every project's tree: the active one first, then each parked one. */
export function getAllTreeRoots(state: Pick<WorkspaceState, 'root' | 'parkedTrees'>): PaneNode[] {
  return [state.root, ...Object.values(state.parkedTrees).map((tree) => tree.root)]
}

/** Session ids that have an agent-chat tab in at least one tree (active or parked). */
export function getAgentChatSessionIdsInAllTrees(
  state: Pick<WorkspaceState, 'root' | 'parkedTrees'>
): Set<string> {
  const ids = new Set<string>()
  for (const root of getAllTreeRoots(state)) {
    for (const leaf of getAllLeafPanes(root)) {
      for (const tab of leaf.tabs) {
        if (tab.type === 'agent-chat') ids.add(tab.sessionId)
      }
    }
  }
  return ids
}
