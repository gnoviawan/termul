/**
 * Terminal/editor sync, reset and remap slice — extracted from ../../workspace-store.ts.
 * Pure move, no logic changes.
 */

import type { StateCreator } from 'zustand'
import { useTerminalStore } from '@/stores/terminal-store'
import type { PaneNode } from '@/types/workspace.types'
import {
  createLeaf,
  editorTabId,
  findPaneById,
  getAllLeafPanes,
  normalizePaneTree,
  resolveFullscreenPaneId,
  terminalTabId,
  updateLeaf
} from '../tree'
import type { WorkspaceState, WorkspaceTab } from '../types'

// CRITICAL: Global lock to prevent syncTerminalTabs from running multiple times concurrently
// This prevents duplicate tab creation during rapid state changes
let SYNC_TERMINAL_TABS_LOCK = false
let SYNC_CALL_COUNT = 0

type SyncSliceState = Pick<
  WorkspaceState,
  | 'syncTerminalTabs'
  | 'clearEditorTabs'
  | 'clearPane'
  | 'resetLayout'
  | 'loadProjectWorkspace'
  | 'syncEditorTabs'
  | 'remapTerminalTabs'
  | 'getNextTabId'
>

export const createSyncSlice: StateCreator<WorkspaceState, [], [], SyncSliceState> = (
  set,
  get
) => ({
  syncTerminalTabs: (terminalIds: string[]): void => {
    // CRITICAL: Skip if sync is already in progress to prevent duplicate tab creation
    if (SYNC_TERMINAL_TABS_LOCK) {
      console.warn('[syncTerminalTabs] SKIPPED: sync already in progress', {
        callCount: ++SYNC_CALL_COUNT
      })
      return
    }

    SYNC_TERMINAL_TABS_LOCK = true
    SYNC_CALL_COUNT++

    try {
      const { root } = get()
      const terminalTabIds = new Set(terminalIds.map(terminalTabId))

      // Collect terminal IDs whose ConnectedTerminal may not have a ptyId yet.
      // These "pending" terminals have a store record but no PTY — they're still
      // initializing (agent launch creates the store record before the PTY is
      // fully bound).  PaneContent already renders a "Connecting..." placeholder
      // for such terminals.  We must NOT remove their workspace tabs or the
      // component unmounts, killing the PTY that was just spawned.
      const terminalStore = useTerminalStore.getState()

      const allLeaves = getAllLeafPanes(root)

      let newRoot = root
      let didChange = false

      // Remove orphaned terminal tabs from all panes.
      // A tab is orphaned only when its terminalId is NOT in the store at all.
      // Tabs whose terminal exists but lacks a ptyId are "pending" and must
      // be preserved to avoid the MOUNT/UNMOUNT cascade described in the
      // agent-launcher-spawn-issue investigation.
      for (const leaf of allLeaves) {
        const hasOrphans = leaf.tabs.some(
          (t) =>
            t.type === 'terminal' &&
            !terminalTabIds.has(t.id) &&
            // Preserve tabs for terminals that exist in the store (even without
            // a ptyId). These are pending initialization and will sync once
            // the PTY is assigned.
            (t.terminalId
              ? !terminalStore.terminals.some((term) => term.id === t.terminalId)
              : true)
        )
        if (hasOrphans) {
          didChange = true
          newRoot = updateLeaf(newRoot, leaf.id, (l) => {
            const newTabs = l.tabs.filter(
              (t) =>
                t.type !== 'terminal' ||
                terminalTabIds.has(t.id) ||
                // Keep pending terminals whose store record exists but ptyId
                // hasn't been assigned yet.
                (t.terminalId
                  ? terminalStore.terminals.some((term) => term.id === t.terminalId)
                  : false)
            )
            let newActive = l.activeTabId
            if (newActive && !newTabs.some((t) => t.id === newActive)) {
              newActive = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null
            }
            return { ...l, tabs: newTabs, activeTabId: newActive }
          })
        }
      }

      // Add missing terminal tabs to the active pane
      const { activePaneId } = get()
      const existingTerminalIds = new Set<string>()
      getAllLeafPanes(newRoot).forEach((leaf) => {
        leaf.tabs.forEach((t) => {
          if (t.type === 'terminal') existingTerminalIds.add(t.id)
        })
      })

      for (const tid of terminalIds) {
        const id = terminalTabId(tid)
        if (!existingTerminalIds.has(id)) {
          didChange = true
          newRoot = updateLeaf(newRoot, activePaneId, (leaf) => ({
            ...leaf,
            tabs: [...leaf.tabs, { type: 'terminal' as const, id, terminalId: tid }],
            activeTabId: id
          }))
        }
      }

      if (!didChange) {
        return
      }

      const normalizedRoot = normalizePaneTree(newRoot)
      set((state) => ({
        root: normalizedRoot,
        fullscreenPaneId: resolveFullscreenPaneId(normalizedRoot, state.fullscreenPaneId)
      }))
    } finally {
      // CRITICAL: Always release the lock
      SYNC_TERMINAL_TABS_LOCK = false
    }
  },

  clearEditorTabs: (): void => {
    const { root } = get()
    const allLeaves = getAllLeafPanes(root)
    let newRoot = root

    for (const leaf of allLeaves) {
      const hasEditors = leaf.tabs.some((t) => t.type === 'editor')
      if (hasEditors) {
        newRoot = updateLeaf(newRoot, leaf.id, (l) => {
          const newTabs = l.tabs.filter((t) => t.type !== 'editor')
          let newActive = l.activeTabId
          if (newActive && !newTabs.some((t) => t.id === newActive)) {
            newActive = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null
          }
          return { ...l, tabs: newTabs, activeTabId: newActive }
        })
      }
    }

    set({ root: newRoot })
  },

  clearPane: (paneId: string): void => {
    const { root } = get()
    const allLeaves = getAllLeafPanes(root)
    const leaf = allLeaves.find((l) => l.id === paneId)
    if (!leaf || leaf.tabs.length === 0) return

    const newRoot = updateLeaf(root, paneId, (l) => ({
      ...l,
      tabs: [],
      activeTabId: null
    }))
    set({ root: newRoot })
  },

  resetLayout: (): void => {
    const leaf = createLeaf()
    set({ root: leaf, activePaneId: leaf.id, fullscreenPaneId: null })
  },

  loadProjectWorkspace: (root: PaneNode, activePaneId?: string | null): void => {
    const normalizedRoot = normalizePaneTree(root)
    const leaves = getAllLeafPanes(normalizedRoot)
    const resolvedActivePaneId =
      activePaneId && leaves.some((leaf) => leaf.id === activePaneId)
        ? activePaneId
        : (leaves[0]?.id ?? normalizedRoot.id)

    set((state) => ({
      root: normalizedRoot,
      activePaneId: resolvedActivePaneId,
      fullscreenPaneId: resolveFullscreenPaneId(normalizedRoot, state.fullscreenPaneId)
    }))
  },

  syncEditorTabs: (filePaths: string[], restoredActiveTabId?: string | null): void => {
    const { root, activePaneId } = get()
    // For backward compat: put all editor tabs in the active pane
    // First remove all editor tabs from all panes
    let newRoot = root
    const allLeaves = getAllLeafPanes(root)
    for (const leaf of allLeaves) {
      const hasEditors = leaf.tabs.some((t) => t.type === 'editor')
      if (hasEditors) {
        newRoot = updateLeaf(newRoot, leaf.id, (l) => ({
          ...l,
          tabs: l.tabs.filter((t) => t.type !== 'editor'),
          activeTabId:
            l.activeTabId && l.tabs.find((t) => t.id === l.activeTabId)?.type === 'editor'
              ? null
              : l.activeTabId
        }))
      }
    }

    // Add editor tabs to active pane
    const editorTabs: WorkspaceTab[] = filePaths.map((fp) => ({
      type: 'editor' as const,
      id: editorTabId(fp),
      filePath: fp
    }))

    newRoot = updateLeaf(newRoot, activePaneId, (leaf) => {
      const termTabs = leaf.tabs.filter((t) => t.type === 'terminal')
      const existingNonEditorNonTerminal = leaf.tabs.filter(
        (t) => t.type !== 'terminal' && t.type !== 'editor'
      )
      const dedupedEditorTabs = editorTabs.filter(
        (editorTab, index, arr) => arr.findIndex((t) => t.id === editorTab.id) === index
      )
      const newTabs = [...termTabs, ...existingNonEditorNonTerminal, ...dedupedEditorTabs]
      let newActive = restoredActiveTabId ?? null
      if (!newActive || !newTabs.some((t) => t.id === newActive)) {
        newActive = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null
      }
      return { ...leaf, tabs: newTabs, activeTabId: newActive }
    })

    const normalizedRoot = normalizePaneTree(newRoot)
    set((state) => ({
      root: normalizedRoot,
      fullscreenPaneId: resolveFullscreenPaneId(normalizedRoot, state.fullscreenPaneId)
    }))
  },

  remapTerminalTabs: (idMap: Record<string, string>): void => {
    const { root, activePaneId } = get()
    const mappedEntries = Object.entries(idMap).filter(([oldId, newId]) => oldId && newId)
    if (mappedEntries.length === 0) {
      return
    }

    const byOldId = new Map(mappedEntries)
    const byOldTabId = new Map(
      mappedEntries.map(([oldId, newId]) => [terminalTabId(oldId), terminalTabId(newId)])
    )

    const remapNode = (node: PaneNode): PaneNode => {
      if (node.type === 'leaf') {
        const remappedTabs = node.tabs.flatMap((tab): WorkspaceTab[] => {
          if (tab.type !== 'terminal') {
            return [tab]
          }

          const mappedTerminalId = byOldId.get(tab.terminalId)
          if (!mappedTerminalId) {
            return [tab]
          }

          const mappedTabId = terminalTabId(mappedTerminalId)

          if (
            node.tabs.some(
              (existing) =>
                existing.type === 'terminal' &&
                existing.id === mappedTabId &&
                existing.terminalId === mappedTerminalId
            )
          ) {
            return []
          }

          return [
            {
              type: 'terminal',
              id: mappedTabId,
              terminalId: mappedTerminalId
            }
          ]
        })

        let activeTabId = node.activeTabId
        if (activeTabId && byOldTabId.has(activeTabId)) {
          activeTabId = byOldTabId.get(activeTabId)!
        }

        if (activeTabId && !remappedTabs.some((tab) => tab.id === activeTabId)) {
          activeTabId = remappedTabs.length > 0 ? remappedTabs[remappedTabs.length - 1].id : null
        }

        return {
          ...node,
          tabs: remappedTabs,
          activeTabId
        }
      }

      return {
        ...node,
        children: node.children.map(remapNode)
      }
    }

    const remappedRoot = normalizePaneTree(remapNode(root))
    const leaves = getAllLeafPanes(remappedRoot)
    const nextActivePaneId = leaves.some((leaf) => leaf.id === activePaneId)
      ? activePaneId
      : (leaves[0]?.id ?? remappedRoot.id)

    set((state) => ({
      root: remappedRoot,
      activePaneId: nextActivePaneId,
      fullscreenPaneId: resolveFullscreenPaneId(remappedRoot, state.fullscreenPaneId)
    }))
  },

  getNextTabId: (direction: 1 | -1): string | null => {
    const { root, activePaneId } = get()
    const pane = findPaneById(root, activePaneId)
    if (pane?.type !== 'leaf' || pane.tabs.length === 0) return null
    if (!pane.activeTabId) return pane.tabs[0].id

    const currentIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId)
    if (currentIndex === -1) return pane.tabs[0].id

    const nextIndex = (currentIndex + direction + pane.tabs.length) % pane.tabs.length
    return pane.tabs[nextIndex].id
  }
})
