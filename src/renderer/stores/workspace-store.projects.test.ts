import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LeafNode } from '@/types/workspace.types'
import { createProjectWorkspace, type ProjectWorkspace, useWorkspaceStore } from './workspace-store'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

function store() {
  return useWorkspaceStore.getState()
}

function leafWith(id: string, terminalId: string): LeafNode {
  const tabId = `term-${terminalId}`
  return {
    type: 'leaf',
    id,
    tabs: [{ type: 'terminal', id: tabId, terminalId }],
    activeTabId: tabId
  }
}

function treeOf(leaf: LeafNode): ProjectWorkspace {
  return {
    root: leaf,
    activePaneId: leaf.id,
    fullscreenPaneId: null,
    agentLauncherPaneId: null,
    agentBrowserPaneId: null
  }
}

describe('workspace-store per-project trees', () => {
  beforeEach(() => {
    const fresh = createProjectWorkspace()
    useWorkspaceStore.setState({ ...fresh, activeProjectId: '', parkedTrees: {} })
  })

  it('first activation loads the staged tree and parks nothing', () => {
    const treeA = treeOf(leafWith('pane-a', 'ta'))

    store().activateProject('A', treeA)

    expect(store().activeProjectId).toBe('A')
    expect(store().root).toBe(treeA.root)
    expect(store().activePaneId).toBe('pane-a')
    expect(store().parkedTrees).toEqual({})
  })

  it('parks the active tree by reference and restores it by reference', () => {
    const treeA = treeOf(leafWith('pane-a', 'ta'))
    const treeB = treeOf(leafWith('pane-b', 'tb'))
    store().activateProject('A', treeA)
    store().showAgentLauncher('pane-a')
    store().activateProject('B', treeB)

    // A is parked as the very same objects (no clone, no re-parse), launcher state included.
    const parkedA = store().parkedTrees.A
    expect(parkedA.root).toBe(treeA.root)
    expect(parkedA.agentLauncherPaneId).toBe('pane-a')
    expect(store().root).toBe(treeB.root)
    expect(store().agentLauncherPaneId).toBeNull()

    // Coming back ignores any staged tree: the parked one wins, by reference.
    store().activateProject('A', treeOf(leafWith('stale', 'zz')))

    expect(store().root).toBe(treeA.root)
    expect(store().activePaneId).toBe('pane-a')
    expect(store().agentLauncherPaneId).toBe('pane-a')
    expect(store().parkedTrees.A).toBeUndefined()
    expect(store().parkedTrees.B.root).toBe(treeB.root)
  })

  it('activates a fresh single-leaf workspace when there is neither a parked nor a staged tree', () => {
    store().activateProject('A', treeOf(leafWith('pane-a', 'ta')))

    store().activateProject('B')

    expect(store().root).toMatchObject({ type: 'leaf', tabs: [], activeTabId: null })
    expect(store().root.id).not.toBe('pane-a')
    expect(store().activePaneId).toBe(store().root.id)
  })

  it('re-activating the visible project only swaps in an explicit tree', () => {
    const treeA = treeOf(leafWith('pane-a', 'ta'))
    store().activateProject('A', treeA)

    store().activateProject('A')
    expect(store().root).toBe(treeA.root)

    const replacement = treeOf(leafWith('pane-a2', 'tb'))
    store().activateProject('A', replacement)
    expect(store().root).toBe(replacement.root)
    expect(store().parkedTrees).toEqual({})
  })

  it('reports and returns active and parked trees, and drops only parked ones', () => {
    const treeA = treeOf(leafWith('pane-a', 'ta'))
    const treeB = treeOf(leafWith('pane-b', 'tb'))
    store().activateProject('A', treeA)
    store().activateProject('B', treeB)

    expect(store().hasProjectTree('A')).toBe(true)
    expect(store().hasProjectTree('B')).toBe(true)
    expect(store().hasProjectTree('C')).toBe(false)
    expect(store().getProjectTree('A')?.root).toBe(treeA.root)
    expect(store().getProjectTree('B')?.root).toBe(treeB.root)
    expect(store().getProjectTree('C')).toBeUndefined()

    store().dropProjectTree('B') // active: never dropped
    expect(store().root).toBe(treeB.root)
    store().dropProjectTree('A')
    expect(store().hasProjectTree('A')).toBe(false)
  })

  it('removeTab falls back to the parked tree that holds the tab', () => {
    const parkedLeaf: LeafNode = {
      type: 'leaf',
      id: 'pane-a',
      tabs: [
        { type: 'terminal', id: 'term-t1', terminalId: 't1' },
        { type: 'terminal', id: 'term-t2', terminalId: 't2' }
      ],
      activeTabId: 'term-t1'
    }
    const treeB = treeOf(leafWith('pane-b', 'tb'))
    store().activateProject('A', treeOf(parkedLeaf))
    store().activateProject('B', treeB)

    store().removeTab('term-t1')

    const parked = store().parkedTrees.A.root as LeafNode
    expect(parked.tabs.map((tab) => tab.id)).toEqual(['term-t2'])
    expect(parked.activeTabId).toBe('term-t2')
    // The visible tree is untouched.
    expect(store().root).toBe(treeB.root)

    store().removeTab('term-nowhere')
    expect((store().parkedTrees.A.root as LeafNode).tabs).toHaveLength(1)
  })

  it('removeTab prefers the visible tree', () => {
    store().activateProject('A', treeOf(leafWith('pane-a', 't1')))
    store().activateProject('B', treeOf(leafWith('pane-b', 't1')))

    store().removeTab('term-t1')

    expect((store().root as LeafNode).tabs).toEqual([])
    expect((store().parkedTrees.A.root as LeafNode).tabs).toHaveLength(1)
  })

  describe('updatePaneSizes with a project id', () => {
    function splitTree(splitId: string, left: string, right: string): ProjectWorkspace {
      const a = leafWith(left, `t-${left}`)
      const b = leafWith(right, `t-${right}`)
      return treeOf({
        type: 'split',
        id: splitId,
        direction: 'horizontal',
        children: [a, b],
        sizes: [50, 50]
      } as unknown as LeafNode)
    }

    it('resizes a parked tree in place and leaves the visible tree untouched', () => {
      store().activateProject('A', splitTree('split-a', 'a1', 'a2'))
      store().activateProject('B', splitTree('split-b', 'b1', 'b2'))
      const visibleRoot = store().root

      store().updatePaneSizes('split-a', [30, 70], 'A')

      const parkedRoot = store().parkedTrees.A.root
      expect(parkedRoot.type === 'split' && parkedRoot.sizes).toEqual([30, 70])
      expect(store().root).toBe(visibleRoot)
    })

    it('treats the active project id as the visible tree and ignores unknown projects', () => {
      store().activateProject('A', splitTree('split-a', 'a1', 'a2'))
      store().activateProject('B', splitTree('split-b', 'b1', 'b2'))

      store().updatePaneSizes('split-b', [20, 80], 'B')
      const visible = store().root
      expect(visible.type === 'split' && visible.sizes).toEqual([20, 80])

      const before = store().parkedTrees
      store().updatePaneSizes('split-a', [10, 90], 'gone')
      expect(store().parkedTrees).toBe(before)
      const parkedA = store().parkedTrees.A.root
      expect(parkedA.type === 'split' && parkedA.sizes).toEqual([50, 50])
    })
  })
})
