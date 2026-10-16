import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LeafNode, SplitNode } from '@/types/workspace.types'
import type { WorkspaceState, WorkspaceTab } from './workspace-store'
import { useWorkspaceStore } from './workspace-store'

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn().mockResolvedValue(undefined)
}))

function leavesOf(node: WorkspaceState['root']): LeafNode[] {
  if (node.type === 'leaf') return [node]
  return node.children.flatMap(leavesOf)
}

const diffTabs = (): WorkspaceTab[] =>
  leavesOf(useWorkspaceStore.getState().root).flatMap((leaf) =>
    leaf.tabs.filter((t) => t.type === 'diff')
  )

const diffKindTabs = (): WorkspaceTab[] =>
  leavesOf(useWorkspaceStore.getState().root).flatMap((leaf) =>
    leaf.tabs.filter((t) => t.type === 'diff' || t.type === 'commit-diff')
  )

describe('workspace-store addDiffTab', () => {
  beforeEach(() => {
    useWorkspaceStore.setState(() => {
      const root: LeafNode = { type: 'leaf', id: 'pane-root', tabs: [], activeTabId: null }
      return { root, activePaneId: 'pane-root', fullscreenPaneId: null }
    })
  })

  it('collapses opens with different path forms of one identity into one focused tab', () => {
    const store = useWorkspaceStore.getState()
    store.addDiffTab('E:\\p', 'a\\b.ts', false, 'pane-root')
    store.addDiffTab('e:/p/', 'a/b.ts', false, 'pane-root')

    const tabs = diffTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].id).toMatch(/^diff:/)
    expect(tabs[0]).toMatchObject({ cwd: 'E:\\p', path: 'a/b.ts', staged: false })
    expect((useWorkspaceStore.getState().root as LeafNode).activeTabId).toBe(tabs[0].id)
  })

  it('focuses the existing tab in another pane instead of adding one', () => {
    const store = useWorkspaceStore.getState()
    store.addDiffTab('/repo', 'a.ts', true, 'pane-root')
    store.splitPane(
      'pane-root',
      'horizontal',
      { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' },
      'right'
    )
    const split = useWorkspaceStore.getState().root as SplitNode
    const leftPaneId = (split.children[0] as LeafNode).id
    const rightPaneId = (split.children[1] as LeafNode).id
    store.setActivePane(rightPaneId)

    store.addDiffTab('/repo', 'a.ts', true, rightPaneId)

    expect(diffTabs()).toHaveLength(1)
    expect(useWorkspaceStore.getState().activePaneId).toBe(leftPaneId)
    const holder = leavesOf(useWorkspaceStore.getState().root).find((leaf) =>
      leaf.tabs.some((t) => t.type === 'diff')
    )
    expect(holder?.id).toBe(leftPaneId)
    expect(holder?.activeTabId).toBe(diffTabs()[0].id)
  })

  it('keeps distinct tabs per side and per working copy', () => {
    const store = useWorkspaceStore.getState()
    store.addDiffTab('/repo', 'a.ts', false, 'pane-root')
    store.addDiffTab('/repo', 'a.ts', true, 'pane-root')
    store.addDiffTab('/repo-wt', 'a.ts', false, 'pane-root')
    expect(new Set(diffTabs().map((t) => t.id)).size).toBe(3)
  })

  it('adds a new tab to the active pane when no target is given', () => {
    useWorkspaceStore.getState().addDiffTab('/repo', 'a.ts', false)
    expect((useWorkspaceStore.getState().root as LeafNode).tabs).toHaveLength(1)
  })

  it('stores the normalized repo-relative path for a backslash input', () => {
    useWorkspaceStore.getState().addDiffTab('/repo', '.\\src\\a.ts', false, 'pane-root')
    expect(diffTabs()[0]).toMatchObject({ cwd: '/repo', path: 'src/a.ts' })
  })

  it('leaves fullscreen when focusing an existing tab held by another pane', () => {
    const store = useWorkspaceStore.getState()
    store.addDiffTab('/repo', 'a.ts', true, 'pane-root')
    store.splitPane(
      'pane-root',
      'horizontal',
      { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' },
      'right'
    )
    const split = useWorkspaceStore.getState().root as SplitNode
    const leftPaneId = (split.children[0] as LeafNode).id
    const rightPaneId = (split.children[1] as LeafNode).id
    store.setActivePane(rightPaneId)
    store.togglePaneFullscreen(rightPaneId)
    expect(useWorkspaceStore.getState().fullscreenPaneId).toBe(rightPaneId)

    store.addDiffTab('/repo', 'a.ts', true, rightPaneId)

    const state = useWorkspaceStore.getState()
    expect(state.fullscreenPaneId).toBeNull()
    expect(state.activePaneId).toBe(leftPaneId)
  })

  it('keeps fullscreen when the existing tab lives in the fullscreen pane', () => {
    const store = useWorkspaceStore.getState()
    store.addDiffTab('/repo', 'a.ts', true, 'pane-root')
    store.splitPane(
      'pane-root',
      'horizontal',
      { type: 'editor', id: 'edit-/a.ts', filePath: '/a.ts' },
      'right'
    )
    store.togglePaneFullscreen('pane-root')
    expect(useWorkspaceStore.getState().fullscreenPaneId).toBe('pane-root')
    store.addDiffTab('/repo', 'a.ts', true, 'pane-root')
    expect(useWorkspaceStore.getState().fullscreenPaneId).toBe('pane-root')
  })
})

describe('workspace-store addCommitDiffTab', () => {
  const HASH = 'e44b917c2a90d3f81b6e0c4a'.padEnd(40, '0')

  beforeEach(() => {
    useWorkspaceStore.setState(() => {
      const root: LeafNode = { type: 'leaf', id: 'pane-root', tabs: [], activeTabId: null }
      return { root, activePaneId: 'pane-root', fullscreenPaneId: null }
    })
  })

  it('opens one read-only commit diff tab per (working copy, commit, path) and focuses it again', () => {
    const store = useWorkspaceStore.getState()
    store.addCommitDiffTab('/repo', HASH, 'src/new.ts', 'src/old.ts')
    store.addCommitDiffTab('/repo/', HASH, 'src/new.ts', 'src/old.ts')

    const tabs = diffKindTabs()
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({
      type: 'commit-diff',
      cwd: '/repo',
      path: 'src/new.ts',
      commit: HASH,
      oldPath: 'src/old.ts'
    })
    expect(tabs[0]).not.toHaveProperty('staged')
    expect((useWorkspaceStore.getState().root as LeafNode).activeTabId).toBe(tabs[0].id)
  })

  it('keeps the commit diff apart from the working-tree diff of the same path', () => {
    const store = useWorkspaceStore.getState()
    store.addDiffTab('/repo', 'src/a.ts', false, 'pane-root')
    store.addCommitDiffTab('/repo', HASH, 'src/a.ts')
    store.addCommitDiffTab('/repo', 'f'.repeat(40), 'src/a.ts')

    const tabs = diffKindTabs()
    expect(tabs).toHaveLength(3)
    expect(new Set(tabs.map((t) => t.id)).size).toBe(3)
    expect(tabs[1]).not.toHaveProperty('oldPath')
  })
})
