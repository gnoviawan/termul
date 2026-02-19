import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import type {
  PaneNode,
  LeafNode,
  SplitNode,
  PaneDirection,
  DropPosition
} from '@/types/workspace.types'

export type WorkspaceTab =
  | { type: 'terminal'; id: string; terminalId: string }
  | { type: 'editor'; id: string; filePath: string }

// --- Tree helper functions ---

export function findPaneById(root: PaneNode, id: string): PaneNode | null {
  if (root.id === id) return root
  if (root.type === 'split') {
    for (const child of root.children) {
      const found = findPaneById(child, id)
      if (found) return found
    }
  }
  return null
}

export function findParentSplit(root: PaneNode, childId: string): SplitNode | null {
  if (root.type === 'split') {
    for (const child of root.children) {
      if (child.id === childId) return root
      const found = findParentSplit(child, childId)
      if (found) return found
    }
  }
  return null
}

export function getAllLeafPanes(root: PaneNode): LeafNode[] {
  if (root.type === 'leaf') return [root]
  return root.children.flatMap(getAllLeafPanes)
}

export function findPaneContainingTab(root: PaneNode, tabId: string): LeafNode | null {
  if (root.type === 'leaf') {
    return root.tabs.some((t) => t.id === tabId) ? root : null
  }
  for (const child of root.children) {
    const found = findPaneContainingTab(child, tabId)
    if (found) return found
  }
  return null
}

function generateId(): string {
  return crypto.randomUUID()
}

function createLeaf(tabs: WorkspaceTab[] = [], activeTabId: string | null = null): LeafNode {
  return { type: 'leaf', id: generateId(), tabs, activeTabId }
}

// Deep-clone + replace a node by id within the tree
function replaceNode(root: PaneNode, targetId: string, replacement: PaneNode): PaneNode {
  if (root.id === targetId) return replacement
  if (root.type === 'split') {
    return {
      ...root,
      children: root.children.map((child) => replaceNode(child, targetId, replacement))
    }
  }
  return root
}

// Remove a node by id and return the updated tree (or null if the root was removed)
function removeNode(root: PaneNode, targetId: string): PaneNode | null {
  if (root.id === targetId) return null
  if (root.type === 'split') {
    const newChildren: (PaneNode | null)[] = root.children.map((child) =>
      removeNode(child, targetId)
    )
    // Track which indices survived (non-null results)
    const survivingEntries: { node: PaneNode; originalIndex: number }[] = []
    for (let i = 0; i < newChildren.length; i++) {
      if (newChildren[i] !== null) {
        survivingEntries.push({ node: newChildren[i]!, originalIndex: i })
      }
    }
    if (survivingEntries.length === 0) return null
    if (survivingEntries.length === 1) return survivingEntries[0].node
    // Redistribute sizes proportionally based on surviving indices
    const survivingSizes = survivingEntries.map((e) => root.sizes[e.originalIndex])
    const survivingTotal = survivingSizes.reduce((a, b) => a + b, 0)
    const totalOriginal = root.sizes.reduce((a, b) => a + b, 0)
    const normalizedSizes = survivingSizes.map((s) => (s / survivingTotal) * totalOriginal)
    return {
      ...root,
      children: survivingEntries.map((e) => e.node),
      sizes: normalizedSizes
    }
  }
  return root
}

// Update a leaf node within the tree
function updateLeaf(
  root: PaneNode,
  leafId: string,
  updater: (leaf: LeafNode) => LeafNode
): PaneNode {
  if (root.type === 'leaf' && root.id === leafId) {
    return updater(root)
  }
  if (root.type === 'split') {
    return {
      ...root,
      children: root.children.map((child) => updateLeaf(child, leafId, updater))
    }
  }
  return root
}

// --- Store ---

export interface WorkspaceState {
  root: PaneNode
  activePaneId: string

  // Pane tree actions
  splitPane: (
    paneId: string,
    direction: PaneDirection,
    newTab: WorkspaceTab,
    position?: Exclude<DropPosition, 'center'>
  ) => void
  addTabToPane: (paneId: string, tab: WorkspaceTab) => void
  moveTabToPane: (tabId: string, sourcePaneId: string, targetPaneId: string) => void
  moveTabToNewSplit: (
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    position: DropPosition
  ) => void
  closeTab: (paneId: string, tabId: string) => void
  setActiveTab: (paneId: string, tabId: string) => void
  setActivePane: (paneId: string) => void
  updatePaneSizes: (splitId: string, sizes: number[]) => void
  collapsePane: (paneId: string) => void
  reorderTabsInPane: (paneId: string, orderedIds: string[]) => void

  // Legacy compat helpers — derived from tree
  getActiveTab: () => WorkspaceTab | undefined
  getActivePaneLeaf: () => LeafNode | null
  syncTerminalTabs: (terminalIds: string[]) => void
  clearEditorTabs: () => void
  resetLayout: () => void
  syncEditorTabs: (filePaths: string[], activeTabId?: string | null) => void
  remapTerminalTabs: (idMap: Record<string, string>) => void

  // New tab helpers
  addTerminalTab: (terminalId: string, targetPaneId?: string) => void
  addEditorTab: (filePath: string, targetPaneId?: string) => void
  removeTab: (tabId: string) => void
  getNextTabId: (direction: 1 | -1) => string | null
}

function terminalTabId(terminalId: string): string {
  return 'term-' + terminalId
}

function editorTabId(filePath: string): string {
  return 'edit-' + filePath
}

function normalizePaneTree(root: PaneNode): PaneNode {
  const collapse = (node: PaneNode): PaneNode | null => {
    if (node.type === 'leaf') {
      return node
    }

    // Track original indices to correctly map sizes after filtering
    const survivingEntries = node.children
      .map((child, originalIndex) => ({
        child: collapse(child),
        originalIndex
      }))
      .filter((entry): entry is { child: PaneNode; originalIndex: number } => entry.child !== null)

    if (survivingEntries.length === 0) {
      return null
    }

    if (survivingEntries.length === 1) {
      return survivingEntries[0].child
    }

    const originalSizes = node.sizes
    const validSizes = survivingEntries.map((entry) => {
      const raw = originalSizes[entry.originalIndex]
      return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1
    })

    const total = validSizes.reduce((sum, size) => sum + size, 0)
    const normalizedSizes = validSizes.map((size) => (size / total) * 100)

    return {
      ...node,
      children: survivingEntries.map((entry) => entry.child),
      sizes: normalizedSizes
    }
  }

  return collapse(root) ?? createLeaf()
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => {
  const initialLeaf = createLeaf()

  return {
    root: initialLeaf,
    activePaneId: initialLeaf.id,

    splitPane: (
      paneId: string,
      direction: PaneDirection,
      newTab: WorkspaceTab,
      position: Exclude<DropPosition, 'center'> = 'right'
    ): void => {
      const { root } = get()
      const target = findPaneById(root, paneId)
      if (!target || target.type !== 'leaf') return

      const newLeaf = createLeaf([newTab], newTab.id)
      const isLeading = position === 'left' || position === 'top'
      const split: SplitNode = {
        type: 'split',
        id: generateId(),
        direction,
        children: isLeading ? [newLeaf, target] : [target, newLeaf],
        sizes: [50, 50]
      }

      const newRoot = replaceNode(root, paneId, split)
      set({ root: newRoot, activePaneId: newLeaf.id })
    },

    addTabToPane: (paneId: string, tab: WorkspaceTab): void => {
      const { root } = get()
      const pane = findPaneById(root, paneId)
      if (!pane || pane.type !== 'leaf') return

      // Prevent duplicate in same pane
      if (pane.tabs.some((t) => t.id === tab.id)) {
        set({ root: updateLeaf(root, paneId, (l) => ({ ...l, activeTabId: tab.id })) })
        return
      }

      const newRoot = updateLeaf(root, paneId, (leaf) => ({
        ...leaf,
        tabs: [...leaf.tabs, tab],
        activeTabId: tab.id
      }))
      set({ root: newRoot, activePaneId: paneId })
    },

    moveTabToPane: (tabId: string, sourcePaneId: string, targetPaneId: string): void => {
      if (sourcePaneId === targetPaneId) return
      const { root } = get()

      const sourcePane = findPaneById(root, sourcePaneId)
      if (!sourcePane || sourcePane.type !== 'leaf') return

      const tab = sourcePane.tabs.find((t) => t.id === tabId)
      if (!tab) return

      // Remove from source
      let newRoot = updateLeaf(root, sourcePaneId, (leaf) => {
        const newTabs = leaf.tabs.filter((t) => t.id !== tabId)
        const newActive = leaf.activeTabId === tabId
          ? (newTabs.length > 0 ? newTabs[Math.min(leaf.tabs.indexOf(tab), newTabs.length - 1)].id : null)
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

      set({ root: newRoot, activePaneId: targetPaneId })
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
      if (!sourcePane || sourcePane.type !== 'leaf') return

      const tab = sourcePane.tabs.find((t) => t.id === tabId)
      if (!tab) return

      // Remove tab from source
      let newRoot = updateLeaf(root, sourcePaneId, (leaf) => {
        const newTabs = leaf.tabs.filter((t) => t.id !== tabId)
        const idx = leaf.tabs.indexOf(tab)
        const newActive = leaf.activeTabId === tabId
          ? (newTabs.length > 0 ? newTabs[Math.min(idx, newTabs.length - 1)].id : null)
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
      if (!target || target.type !== 'leaf') {
        // If target was the same pane that got removed, just create a single leaf
        const newLeaf = createLeaf([tab], tab.id)
        set({ root: newLeaf, activePaneId: newLeaf.id })
        return
      }

      const direction: PaneDirection =
        position === 'left' || position === 'right' ? 'horizontal' : 'vertical'
      const newLeaf = createLeaf([tab], tab.id)
      const children =
        position === 'left' || position === 'top'
          ? [newLeaf, target]
          : [target, newLeaf]

      const split: SplitNode = {
        type: 'split',
        id: generateId(),
        direction,
        children,
        sizes: [50, 50]
      }

      newRoot = replaceNode(newRoot, targetPaneId, split)
      set({ root: newRoot, activePaneId: newLeaf.id })
    },

    closeTab: (paneId: string, tabId: string): void => {
      const { root, activePaneId } = get()
      let newRoot = updateLeaf(root, paneId, (leaf) => {
        const idx = leaf.tabs.findIndex((t) => t.id === tabId)
        if (idx === -1) return leaf
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
          set({ root: newRoot, activePaneId: newActivePaneId })
          return
        }
      }

      set({ root: newRoot })
    },

    setActiveTab: (paneId: string, tabId: string): void => {
      const { root } = get()
      const newRoot = updateLeaf(root, paneId, (leaf) => ({
        ...leaf,
        activeTabId: tabId
      }))
      set({ root: newRoot, activePaneId: paneId })
    },

    setActivePane: (paneId: string): void => {
      set({ activePaneId: paneId })
    },

    updatePaneSizes: (splitId: string, sizes: number[]): void => {
      const { root } = get()
      const node = findPaneById(root, splitId)
      if (!node || node.type !== 'split') return

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
      set({ root: newRoot, activePaneId: newActivePaneId })
    },

    reorderTabsInPane: (paneId: string, orderedIds: string[]): void => {
      const { root } = get()
      const newRoot = updateLeaf(root, paneId, (leaf) => {
        const tabMap = new Map<string, WorkspaceTab>()
        leaf.tabs.forEach((t) => tabMap.set(t.id, t))

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
      if (!pane || pane.type !== 'leaf') return undefined
      return pane.tabs.find((t) => t.id === pane.activeTabId)
    },

    getActivePaneLeaf: (): LeafNode | null => {
      const { root, activePaneId } = get()
      const pane = findPaneById(root, activePaneId)
      if (!pane || pane.type !== 'leaf') return null
      return pane
    },

    addTerminalTab: (terminalId: string, targetPaneId?: string): void => {
      const id = terminalTabId(terminalId)
      const { root, activePaneId } = get()
      const paneId = targetPaneId ?? activePaneId

      // Check if already exists in any pane
      const existing = findPaneContainingTab(root, id)
      if (existing) {
        // Just activate it
        set({
          root: updateLeaf(root, existing.id, (l) => ({ ...l, activeTabId: id })),
          activePaneId: existing.id
        })
        return
      }

      const tab: WorkspaceTab = { type: 'terminal', id, terminalId }
      get().addTabToPane(paneId, tab)
    },

    addEditorTab: (filePath: string, targetPaneId?: string): void => {
      const id = editorTabId(filePath)
      const { root, activePaneId } = get()
      const paneId = targetPaneId ?? activePaneId

      // Check if already exists in target pane — activate it
      const targetPane = findPaneById(root, paneId)
      if (targetPane && targetPane.type === 'leaf' && targetPane.tabs.some((t) => t.id === id)) {
        set({
          root: updateLeaf(root, paneId, (l) => ({ ...l, activeTabId: id })),
          activePaneId: paneId
        })
        return
      }

      const tab: WorkspaceTab = { type: 'editor', id, filePath }
      get().addTabToPane(paneId, tab)
    },

    removeTab: (tabId: string): void => {
      const { root } = get()
      const pane = findPaneContainingTab(root, tabId)
      if (pane) {
        get().closeTab(pane.id, tabId)
      }
    },

    syncTerminalTabs: (terminalIds: string[]): void => {
      const { root } = get()
      const terminalTabIds = new Set(terminalIds.map(terminalTabId))
      const allLeaves = getAllLeafPanes(root)

      let newRoot = root

      // Remove orphaned terminal tabs from all panes
      for (const leaf of allLeaves) {
        const hasOrphans = leaf.tabs.some(
          (t) => t.type === 'terminal' && !terminalTabIds.has(t.id)
        )
        if (hasOrphans) {
          newRoot = updateLeaf(newRoot, leaf.id, (l) => {
            const newTabs = l.tabs.filter(
              (t) => t.type !== 'terminal' || terminalTabIds.has(t.id)
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
          newRoot = updateLeaf(newRoot, activePaneId, (leaf) => ({
            ...leaf,
            tabs: [...leaf.tabs, { type: 'terminal' as const, id, terminalId: tid }],
            activeTabId: id
          }))
        }
      }

      set({ root: normalizePaneTree(newRoot) })
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

    resetLayout: (): void => {
      const leaf = createLeaf()
      set({ root: leaf, activePaneId: leaf.id })
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
            activeTabId: l.activeTabId && l.tabs.find((t) => t.id === l.activeTabId)?.type === 'editor'
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
        const newTabs = [...termTabs, ...editorTabs]
        let newActive = restoredActiveTabId ?? null
        if (!newActive || !newTabs.some((t) => t.id === newActive)) {
          newActive = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null
        }
        return { ...leaf, tabs: newTabs, activeTabId: newActive }
      })

      set({ root: normalizePaneTree(newRoot) })
    },

    remapTerminalTabs: (idMap: Record<string, string>): void => {
      const { root, activePaneId } = get()
      const mappedEntries = Object.entries(idMap).filter(([oldId, newId]) => oldId && newId)
      if (mappedEntries.length === 0) {
        return
      }

      const byOldId = new Map(mappedEntries)
      const byOldTabId = new Map(mappedEntries.map(([oldId, newId]) => [terminalTabId(oldId), terminalTabId(newId)]))

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
        : leaves[0]?.id ?? remappedRoot.id

      set({ root: remappedRoot, activePaneId: nextActivePaneId })
    },

    getNextTabId: (direction: 1 | -1): string | null => {
      const { root, activePaneId } = get()
      const pane = findPaneById(root, activePaneId)
      if (!pane || pane.type !== 'leaf' || pane.tabs.length === 0) return null
      if (!pane.activeTabId) return pane.tabs[0].id

      const currentIndex = pane.tabs.findIndex((t) => t.id === pane.activeTabId)
      if (currentIndex === -1) return pane.tabs[0].id

      const nextIndex = (currentIndex + direction + pane.tabs.length) % pane.tabs.length
      return pane.tabs[nextIndex].id
    }
  }
})

// Selector hooks
export function useWorkspaceTabs(): WorkspaceTab[] {
  // Returns tabs of the active pane
  return useWorkspaceStore(
    useShallow((state) => {
      const pane = findPaneById(state.root, state.activePaneId)
      if (!pane || pane.type !== 'leaf') return []
      return pane.tabs
    })
  )
}

export function useActiveTab(): WorkspaceTab | undefined {
  return useWorkspaceStore((state) => {
    const pane = findPaneById(state.root, state.activePaneId)
    if (!pane || pane.type !== 'leaf') return undefined
    return pane.tabs.find((t) => t.id === pane.activeTabId)
  })
}

export function useActiveTabId(): string | null {
  return useWorkspaceStore((state) => {
    const pane = findPaneById(state.root, state.activePaneId)
    if (!pane || pane.type !== 'leaf') return null
    return pane.activeTabId
  })
}

export function useActivePaneId(): string {
  return useWorkspaceStore((state) => state.activePaneId)
}

export function usePaneRoot(): PaneNode {
  return useWorkspaceStore((state) => state.root)
}

export function useWorkspaceActions(): Pick<
  WorkspaceState,
  | 'addTerminalTab'
  | 'addEditorTab'
  | 'removeTab'
  | 'setActiveTab'
  | 'reorderTabsInPane'
  | 'syncTerminalTabs'
  | 'clearEditorTabs'
  | 'syncEditorTabs'
  | 'getNextTabId'
  | 'splitPane'
  | 'addTabToPane'
  | 'moveTabToPane'
  | 'moveTabToNewSplit'
  | 'closeTab'
  | 'setActivePane'
  | 'collapsePane'
  | 'updatePaneSizes'
> {
  return useWorkspaceStore(
    useShallow((state) => ({
      addTerminalTab: state.addTerminalTab,
      addEditorTab: state.addEditorTab,
      removeTab: state.removeTab,
      setActiveTab: state.setActiveTab,
      reorderTabsInPane: state.reorderTabsInPane,
      syncTerminalTabs: state.syncTerminalTabs,
      clearEditorTabs: state.clearEditorTabs,
      syncEditorTabs: state.syncEditorTabs,
      getNextTabId: state.getNextTabId,
      splitPane: state.splitPane,
      addTabToPane: state.addTabToPane,
      moveTabToPane: state.moveTabToPane,
      moveTabToNewSplit: state.moveTabToNewSplit,
      closeTab: state.closeTab,
      setActivePane: state.setActivePane,
      collapsePane: state.collapsePane,
      updatePaneSizes: state.updatePaneSizes
    }))
  )
}

export { terminalTabId, editorTabId }

// Derive active terminal/editor from pane tree (source of truth)
export function getActiveTerminalIdFromTree(state: WorkspaceState): string | null {
  const pane = findPaneById(state.root, state.activePaneId)
  if (!pane || pane.type !== 'leaf') return null
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId)
  if (activeTab?.type === 'terminal') return activeTab.terminalId
  return null
}

export function getActiveFilePathFromTree(state: WorkspaceState): string | null {
  const pane = findPaneById(state.root, state.activePaneId)
  if (!pane || pane.type !== 'leaf') return null
  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId)
  if (activeTab?.type === 'editor') return activeTab.filePath
  return null
}
