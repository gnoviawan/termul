/**
 * Pure pane-tree and tab-id helpers — extracted from ../workspace-store.ts.
 * No store dependency. Pure move, no logic changes.
 */

import { logFrontendError } from '@/lib/log-api'
import { randomUUID } from '@/lib/uuid'
import type { LeafNode, PaneNode, SplitNode } from '@/types/workspace.types'
import type { ProjectWorkspace, WorkspaceTab } from './types'

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

export function generateId(): string {
  return randomUUID()
}

export function createLeaf(tabs: WorkspaceTab[] = [], activeTabId: string | null = null): LeafNode {
  return { type: 'leaf', id: generateId(), tabs, activeTabId }
}

// Deep-clone + replace a node by id within the tree
export function replaceNode(root: PaneNode, targetId: string, replacement: PaneNode): PaneNode {
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
export function removeNode(root: PaneNode, targetId: string): PaneNode | null {
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
export function updateLeaf(
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

export function makeBrowserTabId(browserTabId: string): string {
  return `browser-${browserTabId}`
}

export const AGENT_BROWSER_SPLIT_SIZES: [number, number] = [33.3, 66.7]

/**
 * Validate and normalize custom split sizes to sum to 100. Returns null (no
 * custom ratio — use the default equal-share behavior) when absent or when
 * the tuple is malformed (wrong length, non-finite, or non-positive), the
 * latter with a warn log so the bad input is observable in the field.
 */
export function resolveSplitSizes(sizes?: [number, number]): [number, number] | null {
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

export function terminalTabId(terminalId: string): string {
  return `term-${terminalId}`
}

export function editorTabId(filePath: string): string {
  return `edit-${filePath}`
}

export function gitTabId(cwd: string): string {
  return `git-${cwd}`
}

export function gitHistoryTabId(cwd: string): string {
  return `git-history-${cwd}`
}

/** Diff tab id: `diff:` + stable hash of the canonical (cwd, path, side) identity. */
export { commitDiffTabId, diffTabId } from '@/lib/diff-tab-identity'

export function canvasTabId(projectId: string): string {
  return `canvas-${projectId}`
}

export function agentChatTabId(sessionId: string): string {
  return `chat-${sessionId}`
}

export function resolveFullscreenPaneId(
  root: PaneNode,
  fullscreenPaneId: string | null
): string | null {
  if (!fullscreenPaneId) return null
  const pane = findPaneById(root, fullscreenPaneId)
  return pane && pane.type === 'leaf' ? fullscreenPaneId : null
}

export function resolveActivePaneId(
  fullscreenPaneId: string | null,
  requestedPaneId: string
): string {
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

/** A fresh single-leaf workspace. */
export function createProjectWorkspace(): ProjectWorkspace {
  const leaf = createLeaf()
  return {
    root: leaf,
    activePaneId: leaf.id,
    fullscreenPaneId: null,
    agentLauncherPaneId: null,
    agentBrowserPaneId: null
  }
}

/**
 * Workspace for a (possibly un-normalized) tree: normalizes it and resolves
 * the active pane to an existing leaf (first leaf when the request is stale).
 */
export function buildProjectWorkspace(
  root: PaneNode,
  activePaneId?: string | null
): ProjectWorkspace {
  const normalizedRoot = normalizePaneTree(root)
  const leaves = getAllLeafPanes(normalizedRoot)
  return {
    root: normalizedRoot,
    activePaneId:
      activePaneId && leaves.some((leaf) => leaf.id === activePaneId)
        ? activePaneId
        : (leaves[0]?.id ?? normalizedRoot.id),
    fullscreenPaneId: null,
    agentLauncherPaneId: null,
    agentBrowserPaneId: null
  }
}

/**
 * Close `tabId` in `paneId` of a workspace without touching any store. An
 * emptied pane collapses into its sibling (and focus moves there) unless it is
 * the only pane. Returns null when the tab is not in that pane.
 */
export function closeTabInWorkspace(
  workspace: ProjectWorkspace,
  paneId: string,
  tabId: string
): { workspace: ProjectWorkspace; removed: WorkspaceTab } | null {
  const { root, activePaneId } = workspace
  let removed: WorkspaceTab | null = null

  let newRoot = updateLeaf(root, paneId, (leaf) => {
    const idx = leaf.tabs.findIndex((t) => t.id === tabId)
    if (idx === -1) return leaf
    removed = leaf.tabs[idx]
    const newTabs = leaf.tabs.filter((t) => t.id !== tabId)
    let newActive = leaf.activeTabId
    if (leaf.activeTabId === tabId) {
      newActive = newTabs.length > 0 ? newTabs[Math.min(idx, newTabs.length - 1)].id : null
    }
    return { ...leaf, tabs: newTabs, activeTabId: newActive }
  })
  if (!removed) return null

  const pane = findPaneById(newRoot, paneId)
  if (
    pane &&
    pane.type === 'leaf' &&
    pane.tabs.length === 0 &&
    getAllLeafPanes(newRoot).length > 1
  ) {
    // Find sibling to focus
    const parent = findParentSplit(newRoot, paneId)
    let newActivePaneId = activePaneId
    if (parent) {
      const siblingIdx = parent.children.findIndex((c) => c.id !== paneId)
      if (siblingIdx >= 0) {
        const siblingLeaves = getAllLeafPanes(parent.children[siblingIdx])
        newActivePaneId = siblingLeaves.length > 0 ? siblingLeaves[0].id : activePaneId
      }
    }
    newRoot = removeNode(newRoot, paneId) ?? createLeaf()
    return {
      workspace: {
        ...workspace,
        root: newRoot,
        activePaneId: newActivePaneId,
        fullscreenPaneId: resolveFullscreenPaneId(newRoot, workspace.fullscreenPaneId)
      },
      removed
    }
  }
  return { workspace: { ...workspace, root: newRoot }, removed }
}
