import { beforeEach, describe, expect, it, vi } from 'vitest'
import { diffTabId } from '@/lib/diff-tab-identity'
import type { LeafNode } from '@/types/workspace.types'
import { deserializePaneTree, reconcileTerminalTabs, serializePaneTree } from './pane-tree'
import type { PersistedPaneNodeInput } from './types'

const { mockLogFrontendError } = vi.hoisted(() => ({ mockLogFrontendError: vi.fn() }))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

const DIFF_ID = diffTabId('E:\\p', 'src/a.ts', true)

const leaf = (tabs: LeafNode['tabs'], activeTabId: string | null): LeafNode => ({
  type: 'leaf',
  id: 'pane-1',
  tabs,
  activeTabId
})

beforeEach(() => {
  mockLogFrontendError.mockClear()
})

describe('diff tab persistence', () => {
  it('round-trips id, cwd, path and side through serialize and deserialize', () => {
    const tree = leaf(
      [{ type: 'diff', id: DIFF_ID, cwd: 'E:\\p', path: 'src/a.ts', staged: true }],
      DIFF_ID
    )

    const serialized = serializePaneTree(tree)
    if (serialized.type !== 'leaf') throw new Error('expected leaf')
    expect(serialized.tabs).toEqual([
      { type: 'diff', id: DIFF_ID, cwd: 'E:\\p', path: 'src/a.ts', staged: true }
    ])

    const restored = deserializePaneTree(serialized)
    expect(restored).toEqual(tree)
  })

  it('survives reconcile (a diff tab is kept like the other non-terminal kinds)', () => {
    const tree = leaf(
      [{ type: 'diff', id: DIFF_ID, cwd: '/r', path: 'a.ts', staged: false }],
      DIFF_ID
    )
    const reconciled = reconcileTerminalTabs(tree, new Set(), [], null)
    expect((reconciled as LeafNode).tabs).toHaveLength(1)
    expect((reconciled as LeafNode).activeTabId).toBe(DIFF_ID)
  })

  it.each([
    ['missing cwd', { type: 'diff', id: 'diff:x', path: 'a.ts', staged: false }],
    ['missing path', { type: 'diff', id: 'diff:x', cwd: '/r', staged: false }],
    ['non-string cwd', { type: 'diff', id: 'diff:x', cwd: 5, path: 'a.ts', staged: false }],
    ['non-boolean staged', { type: 'diff', id: 'diff:x', cwd: '/r', path: 'a.ts', staged: 'yes' }]
  ])('drops a malformed ref (%s) with one warn and never coerces it', (_label, ref) => {
    const persisted = {
      type: 'leaf',
      id: 'pane-1',
      tabs: [ref],
      activeTabId: 'diff:x'
    } as unknown as PersistedPaneNodeInput

    const restored = deserializePaneTree(persisted) as LeafNode

    expect(restored.tabs).toEqual([])
    expect(restored.activeTabId).toBeNull()
    expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
    expect(mockLogFrontendError).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
  })
})
