import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkspaceStore } from './workspace-store'
import type { WorkspaceState } from './workspace-store'
import type { LeafNode, SplitNode } from '@/types/workspace.types'

function createEditorTab(id: string): { type: 'editor'; id: string; filePath: string } {
  return {
    type: 'editor',
    id,
    filePath: id.replace(/^edit-/, '')
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
        activePaneId: 'pane-root'
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
})
