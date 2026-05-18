import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore, flattenSameDirection, normalizePaneTree } from './workspace-store'
import type { WorkspaceState } from './workspace-store'
import type { LeafNode, SplitNode } from '@/types/workspace.types'

function createEditorTab(id: string): { type: 'editor'; id: string; filePath: string } {
  return {
    type: 'editor',
    id,
    filePath: id.replace(/^edit-/, '')
  }
}

function createTerminalTab(terminalId: string): { type: 'terminal'; id: string; terminalId: string } {
  return {
    type: 'terminal',
    id: `term-${terminalId}`,
    terminalId
  }
}

function getLeavesFromNode(node: WorkspaceState['root']): LeafNode[] {
  if (node.type === 'leaf') return [node]
  return node.children.flatMap(getLeavesFromNode)
}

describe('workspace-store split/move invariants', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    let seq = 0
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      () => `00000000-0000-0000-0000-00000000000${++seq}`
    )
    useWorkspaceStore.setState(() => {
      const root: LeafNode = { type: 'leaf', id: 'pane-root', tabs: [], activeTabId: null }
      return {
        root,
        activePaneId: 'pane-root',
        fullscreenPaneId: null
      }
    })
  })

  it('moves tab to target pane on center drop without creating split', () => {
    const store = useWorkspaceStore.getState()
    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const rootAfterSplit = useWorkspaceStore.getState().root
    expect(rootAfterSplit.type).toBe('split')

    const split = rootAfterSplit as SplitNode
    const leftPane = split.children[0] as LeafNode
    const rightPane = split.children[1] as LeafNode

    store.moveTabToPane(tabA.id, leftPane.id, rightPane.id)

    const rootAfterMove = useWorkspaceStore.getState().root
    const leaves = getLeavesFromNode(rootAfterMove)
    expect(leaves).toHaveLength(1)
    expect(leaves[0].tabs.map((t) => t.id)).toEqual([tabB.id, tabA.id])
    expect(useWorkspaceStore.getState().activePaneId).toBe(leaves[0].id)
  })

  it('creates new split at left edge and places moved tab in leading pane', () => {
    const store = useWorkspaceStore.getState()
    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const splitRoot = useWorkspaceStore.getState().root as SplitNode
    const sourcePane = splitRoot.children[0] as LeafNode
    const targetPane = splitRoot.children[1] as LeafNode

    store.moveTabToNewSplit(tabA.id, sourcePane.id, targetPane.id, 'left')

    const rootAfterMove = useWorkspaceStore.getState().root
    expect(rootAfterMove.type).toBe('split')

    const topSplit = rootAfterMove as SplitNode
    expect(topSplit.children).toHaveLength(2)

    const leadingLeaf = topSplit.children[0] as LeafNode
    const trailingLeaf = topSplit.children[1] as LeafNode

    expect(leadingLeaf.tabs.map((t) => t.id)).toEqual([tabA.id])
    expect(trailingLeaf.id).toBe(targetPane.id)

    expect(useWorkspaceStore.getState().activePaneId).toBe(leadingLeaf.id)
  })

  it('prevents duplicate tab IDs in target pane on moveTabToPane', () => {
    const store = useWorkspaceStore.getState()
    const tab = createEditorTab('edit-/dup.ts')

    store.addTabToPane('pane-root', tab)
    store.splitPane('pane-root', 'horizontal', createEditorTab('edit-/right.ts'), 'right')

    const split = useWorkspaceStore.getState().root as SplitNode
    const leftPane = split.children[0] as LeafNode
    const rightPane = split.children[1] as LeafNode

    store.addTabToPane(rightPane.id, tab)
    store.moveTabToPane(tab.id, leftPane.id, rightPane.id)

    const allLeaves = getLeavesFromNode(useWorkspaceStore.getState().root)
    const updatedRight = allLeaves.find((leaf) => leaf.id === rightPane.id)
    expect(updatedRight).toBeTruthy()
    expect(updatedRight!.tabs.filter((t) => t.id === tab.id)).toHaveLength(1)
  })

  it('collapses empty source pane and reassigns active pane to valid leaf', () => {
    const store = useWorkspaceStore.getState()

    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const split = useWorkspaceStore.getState().root as SplitNode
    const leftPane = split.children[0] as LeafNode
    const rightPane = split.children[1] as LeafNode

    store.moveTabToPane(tabA.id, leftPane.id, rightPane.id)

    const rootAfter = useWorkspaceStore.getState().root
    const leaves = getLeavesFromNode(rootAfter)
    expect(leaves).toHaveLength(1)
    expect(useWorkspaceStore.getState().activePaneId).toBe(leaves[0].id)
  })

  it('places new file split pane according to requested edge position', () => {
    const store = useWorkspaceStore.getState()
    const tab = createEditorTab('edit-/new-file.ts')

    store.splitPane('pane-root', 'vertical', tab, 'top')

    const root = useWorkspaceStore.getState().root
    expect(root.type).toBe('split')

    const split = root as SplitNode
    expect(split.direction).toBe('vertical')
    expect(split.children[0].type).toBe('leaf')
    expect((split.children[0] as LeafNode).tabs[0]?.id).toBe(tab.id)
    expect(useWorkspaceStore.getState().activePaneId).toBe((split.children[0] as LeafNode).id)
  })

  it('remaps restored terminal ids without changing pane placement', () => {
    const store = useWorkspaceStore.getState()
    const terminalA = createTerminalTab('old-a')
    const terminalB = createTerminalTab('old-b')

    store.addTabToPane('pane-root', terminalA)
    store.splitPane('pane-root', 'horizontal', terminalB, 'right')

    const split = useWorkspaceStore.getState().root as SplitNode
    const left = split.children[0] as LeafNode
    const right = split.children[1] as LeafNode

    store.setActiveTab(right.id, terminalB.id)
    store.remapTerminalTabs({ 'old-a': 'new-a', 'old-b': 'new-b' })

    const remappedRoot = useWorkspaceStore.getState().root
    expect(remappedRoot.type).toBe('split')

    const remappedSplit = remappedRoot as SplitNode
    const remappedLeft = remappedSplit.children[0] as LeafNode
    const remappedRight = remappedSplit.children[1] as LeafNode

    expect(remappedLeft.tabs).toEqual([
      { type: 'terminal', id: 'term-new-a', terminalId: 'new-a' }
    ])
    expect(remappedRight.tabs).toEqual([
      { type: 'terminal', id: 'term-new-b', terminalId: 'new-b' }
    ])
    expect(remappedRight.activeTabId).toBe('term-new-b')
  })

  it('ensureTerminalTab adds missing terminal without stealing active tab', () => {
    const store = useWorkspaceStore.getState()
    const editorTab = createEditorTab('edit-/focused.ts')

    store.addTabToPane('pane-root', editorTab)
    store.ensureTerminalTab('terminal-a')

    const pane = useWorkspaceStore.getState().root as LeafNode
    expect(pane.tabs).toEqual([
      editorTab,
      { type: 'terminal', id: 'term-terminal-a', terminalId: 'terminal-a' }
    ])
    expect(pane.activeTabId).toBe(editorTab.id)
  })

  it('ensureTerminalTab can activate inserted terminal when requested', () => {
    const store = useWorkspaceStore.getState()
    const editorTab = createEditorTab('edit-/focused.ts')

    store.addTabToPane('pane-root', editorTab)
    store.ensureTerminalTab('terminal-a', undefined, true)

    const pane = useWorkspaceStore.getState().root as LeafNode
    expect(pane.tabs).toEqual([
      editorTab,
      { type: 'terminal', id: 'term-terminal-a', terminalId: 'terminal-a' }
    ])
    expect(pane.activeTabId).toBe('term-terminal-a')
  })

  it('syncTerminalTabs prunes orphan tabs and preserves split shape', () => {
    const store = useWorkspaceStore.getState()
    const terminalA = createTerminalTab('a')
    const terminalB = createTerminalTab('b')

    store.addTabToPane('pane-root', terminalA)
    store.splitPane('pane-root', 'horizontal', terminalB, 'right')

    store.syncTerminalTabs(['a'])

    const rootAfter = useWorkspaceStore.getState().root
    expect(rootAfter.type).toBe('split')

    const split = rootAfter as SplitNode
    const left = split.children[0] as LeafNode
    const right = split.children[1] as LeafNode

    expect(left.tabs).toEqual([{ type: 'terminal', id: 'term-a', terminalId: 'a' }])
    expect(right.tabs).toEqual([])
  })

  it('toggles fullscreen state for a valid leaf pane and restores on second toggle', () => {
    const store = useWorkspaceStore.getState()
    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const split = useWorkspaceStore.getState().root as SplitNode
    const rightPane = split.children[1] as LeafNode

    store.togglePaneFullscreen(rightPane.id)
    expect(useWorkspaceStore.getState().fullscreenPaneId).toBe(rightPane.id)
    expect(useWorkspaceStore.getState().activePaneId).toBe(rightPane.id)

    store.togglePaneFullscreen(rightPane.id)
    expect(useWorkspaceStore.getState().fullscreenPaneId).toBeNull()
    expect((useWorkspaceStore.getState().root as SplitNode).children).toHaveLength(2)
  })

  it('clears fullscreen state when the fullscreened pane is collapsed away', () => {
    const store = useWorkspaceStore.getState()
    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const split = useWorkspaceStore.getState().root as SplitNode
    const leftPane = split.children[0] as LeafNode
    const rightPane = split.children[1] as LeafNode

    store.togglePaneFullscreen(rightPane.id)
    store.moveTabToPane(tabB.id, rightPane.id, leftPane.id)

    expect(useWorkspaceStore.getState().fullscreenPaneId).toBeNull()
    expect(getLeavesFromNode(useWorkspaceStore.getState().root)).toHaveLength(1)
  })

  it('clears stale fullscreen state during reset and invalid workspace loads', () => {
    const store = useWorkspaceStore.getState()
    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const split = useWorkspaceStore.getState().root as SplitNode
    const rightPane = split.children[1] as LeafNode
    store.togglePaneFullscreen(rightPane.id)

    store.loadProjectWorkspace({ type: 'leaf', id: 'replacement-pane', tabs: [], activeTabId: null })
    expect(useWorkspaceStore.getState().fullscreenPaneId).toBeNull()

    // After loading a single-pane workspace, fullscreen is a no-op
    store.togglePaneFullscreen('replacement-pane')
    expect(useWorkspaceStore.getState().fullscreenPaneId).toBeNull()

    store.resetLayout()
    expect(useWorkspaceStore.getState().fullscreenPaneId).toBeNull()
  })

  it('guards togglePaneFullscreen to no-op when only one leaf pane exists', () => {
    const store = useWorkspaceStore.getState()
    const paneId = useWorkspaceStore.getState().activePaneId

    store.togglePaneFullscreen(paneId)
    expect(useWorkspaceStore.getState().fullscreenPaneId).toBeNull()
  })

  it('redirects setActivePane to the fullscreen pane during fullscreen', () => {
    const store = useWorkspaceStore.getState()
    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const split = useWorkspaceStore.getState().root as SplitNode
    const leftPane = split.children[0] as LeafNode
    const rightPane = split.children[1] as LeafNode

    store.togglePaneFullscreen(leftPane.id)
    store.setActivePane(rightPane.id)
    expect(useWorkspaceStore.getState().activePaneId).toBe(leftPane.id)
  })

  it('redirects setActiveTab to the fullscreen pane during fullscreen', () => {
    const store = useWorkspaceStore.getState()
    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const split = useWorkspaceStore.getState().root as SplitNode
    const leftPane = split.children[0] as LeafNode
    const rightPane = split.children[1] as LeafNode

    store.togglePaneFullscreen(leftPane.id)
    store.setActiveTab(rightPane.id, tabB.id)
    expect(useWorkspaceStore.getState().activePaneId).toBe(leftPane.id)
  })

  it('allows setActivePane/setActiveTab to work normally when fullscreen is not active', () => {
    const store = useWorkspaceStore.getState()
    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const split = useWorkspaceStore.getState().root as SplitNode
    const rightPane = split.children[1] as LeafNode

    store.setActivePane(rightPane.id)
    expect(useWorkspaceStore.getState().activePaneId).toBe(rightPane.id)
  })
})

describe('workspace-store same-direction collapse (ADR-002.6)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    let seq = 0
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      () => `00000000-0000-0000-0000-00000000000${++seq}`
    )
    useWorkspaceStore.setState(() => {
      const root: LeafNode = { type: 'leaf', id: 'pane-root', tabs: [], activeTabId: null }
      return {
        root,
        activePaneId: 'pane-root',
        fullscreenPaneId: null
      }
    })
  })

  it('same-direction horizontal split creates flat group of 3 children', () => {
    const store = useWorkspaceStore.getState()
    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')
    const tabC = createEditorTab('edit-/c.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const afterFirstSplit = useWorkspaceStore.getState().root as SplitNode
    const rightPaneId = (afterFirstSplit.children[1] as LeafNode).id

    // Second horizontal split on right pane → same direction, should collapse
    store.splitPane(rightPaneId, 'horizontal', tabC, 'right')

    const root = useWorkspaceStore.getState().root
    expect(root.type).toBe('split')
    const split = root as SplitNode
    // Should be a flat group of 3, not nested
    expect(split.direction).toBe('horizontal')
    expect(split.children.length).toBe(3)
    expect(split.children.every(c => c.type === 'leaf')).toBe(true)
    expect(split.sizes.length).toBe(3)
    // Sizes should sum to ~100
    const sizeSum = split.sizes.reduce((a, b) => a + b, 0)
    expect(Math.abs(sizeSum - 100)).toBeLessThan(1)
  })

  it('cross-direction split still creates nested structure', () => {
    const store = useWorkspaceStore.getState()
    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')
    const tabC = createEditorTab('edit-/c.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const afterSplit = useWorkspaceStore.getState().root as SplitNode
    const rightPane = (afterSplit.children[1] as LeafNode).id

    // Vertical split inside horizontal → should nest
    store.splitPane(rightPane, 'vertical', tabC, 'bottom')

    const root = useWorkspaceStore.getState().root
    const hSplit = root as SplitNode
    expect(hSplit.direction).toBe('horizontal')
    expect(hSplit.children.length).toBe(2)
    // Right child should be a vertical split
    const rightChild = hSplit.children[1]
    expect(rightChild.type).toBe('split')
    expect((rightChild as SplitNode).direction).toBe('vertical')
    expect((rightChild as SplitNode).children.length).toBe(2)
  })

  it('4 horizontal splits create flat group of 4', () => {
    const store = useWorkspaceStore.getState()
    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')
    const tabC = createEditorTab('edit-/c.ts')
    const tabD = createEditorTab('edit-/d.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const root1 = useWorkspaceStore.getState().root as SplitNode
    const paneB = (root1.children[1] as LeafNode).id
    store.splitPane(paneB, 'horizontal', tabC, 'right')

    const root2 = useWorkspaceStore.getState().root as SplitNode
    // After same-direction collapse, we now have 3 children
    // Find the last pane to split again
    const paneC = (root2.children[2] as LeafNode).id
    store.splitPane(paneC, 'horizontal', tabD, 'right')

    const root = useWorkspaceStore.getState().root as SplitNode
    expect(root.direction).toBe('horizontal')
    expect(root.children.length).toBe(4)
    expect(root.children.every(c => c.type === 'leaf')).toBe(true)
    expect(root.sizes.length).toBe(4)
    const sizeSum = root.sizes.reduce((a, b) => a + b, 0)
    expect(Math.abs(sizeSum - 100)).toBeLessThan(1)
  })

  it('collapsePane from flat group of 3 redistributes sizes', () => {
    const store = useWorkspaceStore.getState()
    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')
    const tabC = createEditorTab('edit-/c.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const root1 = useWorkspaceStore.getState().root as SplitNode
    const paneB = (root1.children[1] as LeafNode).id
    store.splitPane(paneB, 'horizontal', tabC, 'right')

    // Now we have a flat group of 3
    const root2 = useWorkspaceStore.getState().root as SplitNode
    const middlePaneId = (root2.children[1] as LeafNode).id

    // Collapse the middle pane
    store.collapsePane(middlePaneId)

    const root = useWorkspaceStore.getState().root as SplitNode
    expect(root.children.length).toBe(2)
    // Sizes should be redistributed
    const sizeSum = root.sizes.reduce((a, b) => a + b, 0)
    expect(Math.abs(sizeSum - 100)).toBeLessThan(1)
  })

  it('collapsePane from 2-child group collapses to single pane', () => {
    const store = useWorkspaceStore.getState()
    const tabA = createEditorTab('edit-/a.ts')
    const tabB = createEditorTab('edit-/b.ts')

    store.addTabToPane('pane-root', tabA)
    store.splitPane('pane-root', 'horizontal', tabB, 'right')

    const root1 = useWorkspaceStore.getState().root as SplitNode
    const rightPaneId = (root1.children[1] as LeafNode).id

    store.collapsePane(rightPaneId)

    const root = useWorkspaceStore.getState().root
    expect(root.type).toBe('leaf')
  })

  it('flattenSameDirection normalizes nested same-direction splits', () => {
    const leafA: LeafNode = { type: 'leaf', id: 'A', tabs: [], activeTabId: null }
    const leafB: LeafNode = { type: 'leaf', id: 'B', tabs: [], activeTabId: null }
    const leafC: LeafNode = { type: 'leaf', id: 'C', tabs: [], activeTabId: null }

    // Nested: Split(h, [A, Split(h, [B, C])])
    const nestedH: SplitNode = {
      type: 'split',
      id: 'inner',
      direction: 'horizontal',
      children: [leafB, leafC],
      sizes: [50, 50]
    }
    const outerH: SplitNode = {
      type: 'split',
      id: 'outer',
      direction: 'horizontal',
      children: [leafA, nestedH],
      sizes: [40, 60]
    }

    const result = flattenSameDirection(outerH) as SplitNode
    expect(result.direction).toBe('horizontal')
    expect(result.children.length).toBe(3)
    expect((result.children[0] as LeafNode).id).toBe('A')
    expect((result.children[1] as LeafNode).id).toBe('B')
    expect((result.children[2] as LeafNode).id).toBe('C')
    // Sizes should be re-normalized to sum to 100
    const sizeSum = result.sizes.reduce((a, b) => a + b, 0)
    expect(Math.abs(sizeSum - 100)).toBeLessThan(1)
  })

  it('loadProjectWorkspace normalizes nested same-direction splits', () => {
    const leafA: LeafNode = { type: 'leaf', id: 'A', tabs: [], activeTabId: null }
    const leafB: LeafNode = { type: 'leaf', id: 'B', tabs: [], activeTabId: null }
    const leafC: LeafNode = { type: 'leaf', id: 'C', tabs: [], activeTabId: null }

    // Old nested format: Split(h, [A, Split(h, [B, C])])
    const nestedH: SplitNode = {
      type: 'split',
      id: 'inner',
      direction: 'horizontal',
      children: [leafB, leafC],
      sizes: [50, 50]
    }
    const outerH: SplitNode = {
      type: 'split',
      id: 'outer',
      direction: 'horizontal',
      children: [leafA, nestedH],
      sizes: [40, 60]
    }

    const store = useWorkspaceStore.getState()
    store.loadProjectWorkspace(outerH, 'A')

    const root = useWorkspaceStore.getState().root as SplitNode
    expect(root.direction).toBe('horizontal')
    expect(root.children.length).toBe(3)
    expect((root.children[0] as LeafNode).id).toBe('A')
    expect((root.children[1] as LeafNode).id).toBe('B')
    expect((root.children[2] as LeafNode).id).toBe('C')
    const sizeSum = root.sizes.reduce((a, b) => a + b, 0)
    expect(Math.abs(sizeSum - 100)).toBeLessThan(1)
  })
})
