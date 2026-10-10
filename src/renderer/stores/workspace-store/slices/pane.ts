/**
 * Pane-tree action slice — extracted from ../../workspace-store.ts. Pure move, no logic changes.
 */

import type { StateCreator } from 'zustand'
import { navigateToChatSession } from '@/lib/router-navigate'
import type { DropPosition, LeafNode, PaneDirection, SplitNode } from '@/types/workspace.types'
import {
  createLeaf,
  findPaneById,
  findParentSplit,
  generateId,
  getAllLeafPanes,
  removeNode,
  replaceNode,
  resolveActivePaneId,
  resolveFullscreenPaneId,
  resolveSplitSizes,
  updateLeaf
} from '../tree'
import type { AddTabOptions, SplitPaneOptions, WorkspaceState, WorkspaceTab } from '../types'

type PaneSliceState = Pick<
  WorkspaceState,
  | 'showAgentLauncher'
  | 'hideAgentLauncher'
  | 'splitPane'
  | 'addTabToPane'
  | 'moveTabToPane'
  | 'moveTabToNewSplit'
  | 'closeTab'
  | 'setActiveTab'
  | 'setActivePane'
  | 'togglePaneFullscreen'
  | 'clearFullscreenPane'
  | 'updatePaneSizes'
  | 'collapsePane'
  | 'reorderTabsInPane'
  | 'getActiveTab'
  | 'getActivePaneLeaf'
>

export const createPaneSlice: StateCreator<WorkspaceState, [], [], PaneSliceState> = (
  set,
  get
) => ({
  showAgentLauncher: (paneId: string): void => {
    set({ agentLauncherPaneId: paneId })
  },

  hideAgentLauncher: (): void => {
    set({ agentLauncherPaneId: null })
  },

  splitPane: (
    paneId: string,
    direction: PaneDirection,
    newTab: WorkspaceTab,
    position: Exclude<DropPosition, 'center'> = 'right',
    options?: SplitPaneOptions
  ): void => {
    const { root, activePaneId, fullscreenPaneId } = get()
    const target = findPaneById(root, paneId)
    if (target?.type !== 'leaf') return

    const customSizes = resolveSplitSizes(options?.sizes)
    const focus = options?.focus !== false
    const newLeaf = createLeaf([newTab], newTab.id)
    const isLeading = position === 'left' || position === 'top'
    const nextActivePaneId = focus ? newLeaf.id : activePaneId
    // A focusing split moves the user's attention to the new leaf (exit
    // fullscreen, as before); a background split (focus: false) must not
    // eject a fullscreened pane.
    const nextFullscreenPaneId = focus ? null : fullscreenPaneId

    // Same-direction collapse: insert as sibling in existing flat group
    const parentSplit = findParentSplit(root, paneId)
    if (parentSplit && parentSplit.direction === direction) {
      const targetIndex = parentSplit.children.findIndex((c) => c.id === paneId)
      if (targetIndex === -1) return

      const insertIndex = isLeading ? targetIndex : targetIndex + 1

      const newChildren = [...parentSplit.children]
      newChildren.splice(insertIndex, 0, newLeaf)

      let newSizes: number[]
      if (customSizes) {
        // Custom ratio: the target pane keeps its share of its former
        // extent, the new leaf takes the rest — same proportions a nested
        // split with these sizes would produce.
        const keptRatio = customSizes[0] / 100
        const targetSize = parentSplit.sizes[targetIndex] ?? 100 / parentSplit.children.length
        const keptSize = targetSize * keptRatio
        newSizes = [...parentSplit.sizes]
        newSizes[targetIndex] = keptSize
        newSizes.splice(insertIndex, 0, targetSize - keptSize)
      } else {
        const childCount = parentSplit.children.length
        const newSize = 100 / (childCount + 1)
        const scaleFactor = childCount / (childCount + 1)
        newSizes = parentSplit.sizes.map((s) => s * scaleFactor)
        newSizes.splice(insertIndex, 0, newSize)
      }

      const updatedSplit: SplitNode = {
        ...parentSplit,
        children: newChildren,
        sizes: newSizes
      }

      const newRoot = replaceNode(root, parentSplit.id, updatedSplit)
      set({
        root: newRoot,
        activePaneId: nextActivePaneId,
        fullscreenPaneId: nextFullscreenPaneId
      })
      return
    }

    // Default: create nested split
    const splitSizes = customSizes
      ? isLeading
        ? [customSizes[1], customSizes[0]]
        : [customSizes[0], customSizes[1]]
      : [50, 50]
    const split: SplitNode = {
      type: 'split',
      id: generateId(),
      direction,
      children: isLeading ? [newLeaf, target] : [target, newLeaf],
      sizes: splitSizes
    }

    const newRoot = replaceNode(root, paneId, split)
    set({
      root: newRoot,
      activePaneId: nextActivePaneId,
      fullscreenPaneId: nextFullscreenPaneId
    })
  },

  addTabToPane: (paneId: string, tab: WorkspaceTab, options?: AddTabOptions): void => {
    const { root, agentLauncherPaneId } = get()
    const pane = findPaneById(root, paneId)
    if (pane?.type !== 'leaf') return
    const focus = options?.focus !== false

    // Opening or activating any tab means the user has moved on from the
    // agent launcher overlay; auto-dismiss it so it never blocks the panel
    // the user just opened (e.g. an editor, git, or browser tab).
    const nextLauncherPaneId = agentLauncherPaneId === paneId ? null : agentLauncherPaneId

    // Prevent duplicate in same pane
    if (pane.tabs.some((t) => t.id === tab.id)) {
      set({
        root: updateLeaf(root, paneId, (l) => ({ ...l, activeTabId: tab.id })),
        agentLauncherPaneId: nextLauncherPaneId
      })
      return
    }

    const newRoot = updateLeaf(root, paneId, (leaf) => ({
      ...leaf,
      tabs: [...leaf.tabs, tab],
      activeTabId: tab.id
    }))
    set((state) => ({
      root: newRoot,
      activePaneId: focus
        ? resolveActivePaneId(state.fullscreenPaneId, paneId)
        : state.activePaneId,
      agentLauncherPaneId: nextLauncherPaneId
    }))
  },

  moveTabToPane: (tabId: string, sourcePaneId: string, targetPaneId: string): void => {
    if (sourcePaneId === targetPaneId) return
    const { root } = get()

    const sourcePane = findPaneById(root, sourcePaneId)
    if (sourcePane?.type !== 'leaf') return

    const tab = sourcePane.tabs.find((t) => t.id === tabId)
    if (!tab) return

    // Remove from source
    let newRoot = updateLeaf(root, sourcePaneId, (leaf) => {
      const newTabs = leaf.tabs.filter((t) => t.id !== tabId)
      const newActive =
        leaf.activeTabId === tabId
          ? newTabs.length > 0
            ? newTabs[Math.min(leaf.tabs.indexOf(tab), newTabs.length - 1)].id
            : null
          : leaf.activeTabId
      return { ...leaf, tabs: newTabs, activeTabId: newActive }
    })

    // Add to target
    newRoot = updateLeaf(newRoot, targetPaneId, (leaf) => {
      if (leaf.tabs.some((t) => t.id === tabId)) {
        return { ...leaf, activeTabId: tabId }
      }
      return { ...leaf, tabs: [...leaf.tabs, tab], activeTabId: tabId }
    })

    // Collapse empty source pane
    const updatedSource = findPaneById(newRoot, sourcePaneId)
    if (updatedSource && updatedSource.type === 'leaf' && updatedSource.tabs.length === 0) {
      newRoot = removeNode(newRoot, sourcePaneId) ?? createLeaf()
    }

    set((state) => ({
      root: newRoot,
      activePaneId: targetPaneId,
      fullscreenPaneId: resolveFullscreenPaneId(newRoot, state.fullscreenPaneId)
    }))
  },

  moveTabToNewSplit: (
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    position: DropPosition
  ): void => {
    if (position === 'center') {
      get().moveTabToPane(tabId, sourcePaneId, targetPaneId)
      return
    }

    const { root } = get()
    const sourcePane = findPaneById(root, sourcePaneId)
    if (sourcePane?.type !== 'leaf') return

    const tab = sourcePane.tabs.find((t) => t.id === tabId)
    if (!tab) return

    // Remove tab from source
    let newRoot = updateLeaf(root, sourcePaneId, (leaf) => {
      const newTabs = leaf.tabs.filter((t) => t.id !== tabId)
      const idx = leaf.tabs.indexOf(tab)
      const newActive =
        leaf.activeTabId === tabId
          ? newTabs.length > 0
            ? newTabs[Math.min(idx, newTabs.length - 1)].id
            : null
          : leaf.activeTabId
      return { ...leaf, tabs: newTabs, activeTabId: newActive }
    })

    // Collapse empty source pane
    const updatedSource = findPaneById(newRoot, sourcePaneId)
    if (updatedSource && updatedSource.type === 'leaf' && updatedSource.tabs.length === 0) {
      newRoot = removeNode(newRoot, sourcePaneId) ?? createLeaf()
    }

    // Split at target
    const target = findPaneById(newRoot, targetPaneId)
    if (target?.type !== 'leaf') {
      // If target was the same pane that got removed, just create a single leaf
      const newLeaf = createLeaf([tab], tab.id)
      set({ root: newLeaf, activePaneId: newLeaf.id, fullscreenPaneId: null })
      return
    }

    const direction: PaneDirection =
      position === 'left' || position === 'right' ? 'horizontal' : 'vertical'
    const newLeaf = createLeaf([tab], tab.id)

    // Same-direction collapse: insert as sibling in existing flat group
    const parentSplit = findParentSplit(newRoot, targetPaneId)
    if (parentSplit && parentSplit.direction === direction) {
      const targetIndex = parentSplit.children.findIndex((c) => c.id === targetPaneId)
      if (targetIndex === -1) {
        // Fallback
        const newSingleRoot = createLeaf([tab], tab.id)
        set({ root: newSingleRoot, activePaneId: newSingleRoot.id, fullscreenPaneId: null })
        return
      }

      const isLeading = position === 'left' || position === 'top'
      const insertIndex = isLeading ? targetIndex : targetIndex + 1
      const childCount = parentSplit.children.length
      const newSize = 100 / (childCount + 1)
      const scaleFactor = childCount / (childCount + 1)
      const newSizes = parentSplit.sizes.map((s) => s * scaleFactor)
      newSizes.splice(insertIndex, 0, newSize)

      const newChildren = [...parentSplit.children]
      newChildren.splice(insertIndex, 0, newLeaf)

      const updatedSplit: SplitNode = {
        ...parentSplit,
        children: newChildren,
        sizes: newSizes
      }

      newRoot = replaceNode(newRoot, parentSplit.id, updatedSplit)
      set((state) => ({
        root: newRoot,
        activePaneId: newLeaf.id,
        fullscreenPaneId: resolveFullscreenPaneId(newRoot, state.fullscreenPaneId)
      }))
      return
    }

    // Default: create nested split
    const children =
      position === 'left' || position === 'top' ? [newLeaf, target] : [target, newLeaf]

    const split: SplitNode = {
      type: 'split',
      id: generateId(),
      direction,
      children,
      sizes: [50, 50]
    }

    newRoot = replaceNode(newRoot, targetPaneId, split)
    set((state) => ({
      root: newRoot,
      activePaneId: newLeaf.id,
      fullscreenPaneId: resolveFullscreenPaneId(newRoot, state.fullscreenPaneId)
    }))
  },

  closeTab: (paneId: string, tabId: string): WorkspaceTab | null => {
    const { root, activePaneId } = get()
    let removedTab: WorkspaceTab | null = null

    let newRoot = updateLeaf(root, paneId, (leaf) => {
      const idx = leaf.tabs.findIndex((t) => t.id === tabId)
      if (idx === -1) return leaf
      removedTab = leaf.tabs[idx]
      const newTabs = leaf.tabs.filter((t) => t.id !== tabId)
      let newActive = leaf.activeTabId
      if (leaf.activeTabId === tabId) {
        if (newTabs.length > 0) {
          const newIdx = Math.min(idx, newTabs.length - 1)
          newActive = newTabs[newIdx].id
        } else {
          newActive = null
        }
      }
      return { ...leaf, tabs: newTabs, activeTabId: newActive }
    })

    if (!removedTab) {
      return null
    }

    // If pane is now empty and not the only pane, collapse it
    const pane = findPaneById(newRoot, paneId)
    if (pane && pane.type === 'leaf' && pane.tabs.length === 0) {
      const leaves = getAllLeafPanes(newRoot)
      if (leaves.length > 1) {
        // Find sibling to focus
        const parent = findParentSplit(newRoot, paneId)
        let newActivePaneId = activePaneId
        if (parent) {
          const siblingIdx = parent.children.findIndex((c) => c.id !== paneId)
          if (siblingIdx >= 0) {
            const sibling = parent.children[siblingIdx]
            const siblingLeaves = getAllLeafPanes(sibling)
            newActivePaneId = siblingLeaves.length > 0 ? siblingLeaves[0].id : activePaneId
          }
        }
        newRoot = removeNode(newRoot, paneId) ?? createLeaf()
        set((state) => ({
          root: newRoot,
          activePaneId: newActivePaneId,
          fullscreenPaneId: resolveFullscreenPaneId(newRoot, state.fullscreenPaneId)
        }))
        return removedTab
      }
    }

    set({ root: newRoot })
    return removedTab
  },

  setActiveTab: (paneId: string, tabId: string): void => {
    const { root, fullscreenPaneId, agentLauncherPaneId } = get()
    const pane = findPaneById(root, paneId)
    const tab = pane?.type === 'leaf' ? pane.tabs.find((t) => t.id === tabId) : undefined
    const newRoot = updateLeaf(root, paneId, (l) => ({
      ...l,
      activeTabId: tabId
    }))
    set({
      root: newRoot,
      activePaneId: resolveActivePaneId(fullscreenPaneId, paneId),
      agentLauncherPaneId: agentLauncherPaneId === paneId ? null : agentLauncherPaneId
    })
    if (tab && tab.type === 'agent-chat') {
      navigateToChatSession(tab.sessionId)
    }
  },

  setActivePane: (paneId: string): void => {
    const { fullscreenPaneId } = get()
    set({ activePaneId: resolveActivePaneId(fullscreenPaneId, paneId) })
  },

  togglePaneFullscreen: (paneId: string): void => {
    const { root, fullscreenPaneId } = get()
    const pane = findPaneById(root, paneId)
    if (pane?.type !== 'leaf') return

    // If only one leaf pane exists, toggling fullscreen is a no-op
    if (getAllLeafPanes(root).length <= 1 && fullscreenPaneId !== paneId) return

    set({
      activePaneId: paneId,
      fullscreenPaneId: fullscreenPaneId === paneId ? null : paneId
    })
  },

  clearFullscreenPane: (): void => {
    set({ fullscreenPaneId: null })
  },

  updatePaneSizes: (splitId: string, sizes: number[]): void => {
    const { root } = get()
    const node = findPaneById(root, splitId)
    if (node?.type !== 'split') return

    // Skip update if sizes haven't changed to avoid re-render loops
    if (
      node.sizes.length === sizes.length &&
      node.sizes.every((s, i) => Math.abs(s - sizes[i]) < 0.01)
    ) {
      return
    }

    const updatedSplit: SplitNode = { ...node, sizes }
    const newRoot = replaceNode(root, splitId, updatedSplit)
    set({ root: newRoot })
  },

  collapsePane: (paneId: string): void => {
    const { root, activePaneId } = get()
    const leaves = getAllLeafPanes(root)
    if (leaves.length <= 1) return

    const parent = findParentSplit(root, paneId)
    let newActivePaneId = activePaneId
    if (parent) {
      const siblingIdx = parent.children.findIndex((c) => c.id !== paneId)
      if (siblingIdx >= 0) {
        const sibling = parent.children[siblingIdx]
        const siblingLeaves = getAllLeafPanes(sibling)
        if (siblingLeaves.length > 0) {
          newActivePaneId = siblingLeaves[0].id
        }
      }
    }

    const newRoot = removeNode(root, paneId) ?? createLeaf()
    set((state) => ({
      root: newRoot,
      activePaneId: newActivePaneId,
      fullscreenPaneId: resolveFullscreenPaneId(newRoot, state.fullscreenPaneId)
    }))
  },

  reorderTabsInPane: (paneId: string, orderedIds: string[]): void => {
    const { root } = get()
    const newRoot = updateLeaf(root, paneId, (leaf) => {
      const tabMap = new Map<string, WorkspaceTab>()
      leaf.tabs.forEach((t) => {
        tabMap.set(t.id, t)
      })

      const orderedSet = new Set(orderedIds)
      const reordered = orderedIds
        .map((id) => tabMap.get(id))
        .filter((t): t is WorkspaceTab => t !== undefined)

      const missing = leaf.tabs.filter((t) => !orderedSet.has(t.id))
      return { ...leaf, tabs: [...reordered, ...missing] }
    })
    set({ root: newRoot })
  },

  // Legacy compat

  getActiveTab: (): WorkspaceTab | undefined => {
    const { root, activePaneId } = get()
    const pane = findPaneById(root, activePaneId)
    if (pane?.type !== 'leaf') return undefined
    return pane.tabs.find((t) => t.id === pane.activeTabId)
  },

  getActivePaneLeaf: (): LeafNode | null => {
    const { root, activePaneId } = get()
    const pane = findPaneById(root, activePaneId)
    if (pane?.type !== 'leaf') return null
    return pane
  }
})
