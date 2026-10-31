import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LeafNode } from '@/types/workspace.types'
import { deserializePaneTree, reconcileTerminalTabs, serializePaneTree } from './pane-tree'
import type { PersistedPaneNodeInput } from './types'

const { mockLogFrontendError } = vi.hoisted(() => ({ mockLogFrontendError: vi.fn() }))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

const ID = 'github-item-/repo-upstream-42'

const leaf = (tabs: LeafNode['tabs'], activeTabId: string | null): LeafNode => ({
  type: 'leaf',
  id: 'pane-1',
  tabs,
  activeTabId
})

const persistedLeaf = (tab: Record<string, unknown>): PersistedPaneNodeInput =>
  ({
    type: 'leaf',
    id: 'pane-1',
    tabs: [tab],
    activeTabId: null
  }) as unknown as PersistedPaneNodeInput

beforeEach(() => {
  mockLogFrontendError.mockClear()
})

describe('GitHub item tab persistence', () => {
  it('round-trips repo slot, kind, number and title through serialize and deserialize', () => {
    const tree = leaf(
      [
        {
          type: 'github-item',
          id: ID,
          cwd: '/repo',
          repo: 'upstream',
          kind: 'pr',
          number: 42,
          title: 'Fix the flaky test'
        }
      ],
      ID
    )

    const serialized = serializePaneTree(tree)
    if (serialized.type !== 'leaf') throw new Error('expected leaf')
    expect(serialized.tabs).toEqual([
      {
        type: 'github-item',
        id: ID,
        cwd: '/repo',
        repo: 'upstream',
        kind: 'pr',
        number: 42,
        title: 'Fix the flaky test'
      }
    ])
    expect(deserializePaneTree(serialized)).toEqual(tree)
    expect(reconcileTerminalTabs(tree, new Set(), [], null)).toEqual(tree)
  })

  it('drops a ref with an unknown repo slot or a non-integer number, with one warn each', () => {
    const badSlot = deserializePaneTree(
      persistedLeaf({ type: 'github-item', cwd: '/repo', repo: 'fork', kind: 'issue', number: 1 })
    )
    const badNumber = deserializePaneTree(
      persistedLeaf({
        type: 'github-item',
        cwd: '/repo',
        repo: 'origin',
        kind: 'issue',
        number: 1.5
      })
    )

    expect(badSlot).toEqual(leaf([], null))
    expect(badNumber).toEqual(leaf([], null))
    expect(mockLogFrontendError).toHaveBeenCalledTimes(2)
  })

  it('rebuilds the id from cwd, slot and number and tolerates a missing title', () => {
    const restored = deserializePaneTree(
      persistedLeaf({ type: 'github-item', cwd: '/repo', repo: 'origin', kind: 'issue', number: 7 })
    )
    expect(restored).toEqual(
      leaf(
        [
          {
            type: 'github-item',
            id: 'github-item-/repo-origin-7',
            cwd: '/repo',
            repo: 'origin',
            kind: 'issue',
            number: 7,
            title: ''
          }
        ],
        'github-item-/repo-origin-7'
      )
    )
  })
})
