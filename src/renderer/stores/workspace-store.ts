import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'
import { logFrontendError } from '@/lib/log-api'
import { navigateToChatSession } from '@/lib/router-navigate'
import { randomUUID } from '@/lib/uuid'
import { useTerminalStore } from '@/stores/terminal-store'
import type {
  DropPosition,
  LeafNode,
  PaneDirection,
  PaneNode,
  SplitNode
} from '@/types/workspace.types'

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
      /** OpenPencil canvas tab (singleton per project — AD-7): the id is a
       * deterministic function of the projectId, so repeat opens focus the
       * existing tab and a doc switch re-binds `docPath` in place. */
      type: 'canvas'
      id: string
      projectId: string
      docPath: string
    }

// CRITICAL: Global lock to prevent syncTerminalTabs from running multiple times concurrently
// This prevents duplicate tab creation during rapid state changes
let SYNC_TERMINAL_TABS_LOCK = false
let SYNC_CALL_COUNT = 0

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
  return randomUUID()
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

export interface WorkspaceState {
  root: PaneNode
  activePaneId: string
  fullscreenPaneId: string | null
  /** Pane id where the agent launcher overlay is shown, or null to hide it. */
  agentLauncherPaneId: string | null
  /**
   * Pane id of the dedicated agent-browser pane (spec-acp-browser-automation-v2
   * CAP-3). Runtime-only state, never part of the persisted workspace
   * manifest; re-validated against the pane tree on every open.
   */
  agentBrowserPaneId: string | null
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

function makeBrowserTabId(browserTabId: string): string {
  return `browser-${browserTabId}`
}

const AGENT_BROWSER_SPLIT_SIZES: [number, number] = [33.3, 66.7]

/**
 * Validate and normalize custom split sizes to sum to 100. Returns null (no
 * custom ratio — use the default equal-share behavior) when absent or when
 * the tuple is malformed (wrong length, non-finite, or non-positive), the
 * latter with a warn log so the bad input is observable in the field.
 */
function resolveSplitSizes(sizes?: [number, number]): [number, number] | null {
  if (sizes === undefined) return null
  if (sizes.length !== 2 || !sizes.every((s) => Number.isFinite(s) && s > 0)) {
    void logFrontendError({
      level: 'warn',
      message: `[workspace] invalid splitPane sizes ignored, falling back to [50, 50] (sizes=[${sizes.join(', ')}])`,
      source: 'workspace-store:splitPane'
    })
    return null
  }
  const total = sizes[0] + sizes[1]
  return [(sizes[0] / total) * 100, (sizes[1] / total) * 100]
}

function terminalTabId(terminalId: string): string {
  return `term-${terminalId}`
}

function editorTabId(filePath: string): string {
  return `edit-${filePath}`
}

export function gitTabId(cwd: string): string {
  return `git-${cwd}`
}

export function gitHistoryTabId(cwd: string): string {
  return `git-history-${cwd}`
}

export function canvasTabId(projectId: string): string {
  return `canvas-${projectId}`
}

export function agentChatTabId(sessionId: string): string {
  return `chat-${sessionId}`
}

function resolveFullscreenPaneId(root: PaneNode, fullscreenPaneId: string | null): string | null {
  if (!fullscreenPaneId) return null
  const pane = findPaneById(root, fullscreenPaneId)
  return pane && pane.type === 'leaf' ? fullscreenPaneId : null
}

function resolveActivePaneId(fullscreenPaneId: string | null, requestedPaneId: string): string {
  return fullscreenPaneId && fullscreenPaneId !== requestedPaneId
    ? fullscreenPaneId
    : requestedPaneId
}

// Flatten nested same-direction splits into a single flat group.
// E.g. Split(h, [A, Split(h, [B, C])]) → Split(h, [A, B, C])
export function flattenSameDirection(root: PaneNode): PaneNode {
  if (root.type === 'leaf') return root

  // First recursively flatten children
  const flattenedChildren: PaneNode[] = []
  const flattenedSizes: number[] = []

  for (let i = 0; i < root.children.length; i++) {
    const child = flattenSameDirection(root.children[i])
    // If child is same-direction split, merge its children into this level
    if (child.type === 'split' && child.direction === root.direction) {
      const parentSize = root.sizes[i] ?? 1
      const childTotal = child.sizes.reduce((a, b) => a + b, 0)
      for (let j = 0; j < child.children.length; j++) {
        flattenedChildren.push(child.children[j])
        flattenedSizes.push(parentSize * (child.sizes[j] / childTotal))
      }
    } else {
      flattenedChildren.push(child)
      flattenedSizes.push(root.sizes[i] ?? 1)
    }
  }

  // Re-normalize sizes to sum to 100
  const sizeTotal = flattenedSizes.reduce((a, b) => a + b, 1)
  const normalizedSizes = flattenedSizes.map((s) => (s / sizeTotal) * 100)

  return {
    ...root,
    children: flattenedChildren,
    sizes: normalizedSizes
  }
}

export function normalizePaneTree(root: PaneNode): PaneNode {
  const collapse = (node: PaneNode): PaneNode | null => {
    if (node.type === 'leaf') {
      return node
    }

    // First flatten nested same-direction splits
    const flattened = flattenSameDirection(node)

    // After flattenSameDirection, a non-leaf node always yields a SplitNode
    if (flattened.type !== 'split') return null

    // Track original indices to correctly map sizes after filtering
    const survivingEntries = flattened.children
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

    const originalSizes = flattened.sizes
    const validSizes = survivingEntries.map((entry) => {
      const raw = originalSizes[entry.originalIndex]
      return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 1
    })

    const total = validSizes.reduce((sum, size) => sum + size, 0)
    const normalizedSizes = validSizes.map((size) => (size / total) * 100)

    return {
      type: 'split' as const,
      id: flattened.id,
      direction: flattened.direction,
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
    fullscreenPaneId: null,
    agentLauncherPaneId: null,
    agentBrowserPaneId: null,

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
    },

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
      const splitTargetId =
        activePane?.type === 'leaf' ? activePaneId : getAllLeafPanes(root)[0]?.id
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
    },

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
  }
})

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
  return useWorkspaceStore((state) => state.activePaneId)
}

export function useFullscreenPaneId(): string | null {
  return useWorkspaceStore((state) => state.fullscreenPaneId)
}

export function useLeafCount(): number {
  return useWorkspaceStore((state) => getAllLeafPanes(state.root).length)
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

export { editorTabId, makeBrowserTabId as browserTabId, terminalTabId }

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
