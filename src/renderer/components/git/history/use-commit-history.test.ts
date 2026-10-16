import type { GitCommit } from '@shared/types/ipc.types'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getLog } = vi.hoisted(() => ({ getLog: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/git-api', () => ({ gitApi: { getLog } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { useGitHistoryStore } from '@/stores/git-history-store'
import { useCommitHistory } from './use-commit-history'

const CWD = '/repo'

function commit(short: string, subject: string, author: string, parent?: string): GitCommit {
  return {
    hash: short.padEnd(40, '0'),
    shortHash: short,
    parents: parent ? [parent.padEnd(40, '0')] : [],
    refs: [],
    author,
    date: new Date().toISOString(),
    subject
  }
}

const COMMITS = [
  commit('c3c3c3c', 'Add QRIS payment', 'Ada', 'b2b2b2b'),
  commit('b2b2b2b', 'Fix keypad typo', 'Grace', 'a1a1a1a'),
  commit('a1a1a1a', 'Initial commit', 'Ada')
]

describe('useCommitHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getLog.mockResolvedValue(COMMITS)
    useGitHistoryStore.setState({
      commits: { [CWD]: COMMITS },
      loading: {},
      error: {},
      scope: {},
      details: {},
      headSummary: {}
    })
  })

  it('returns the graph order, the layout and the row index when not filtering', () => {
    const { result } = renderHook(() => useCommitHistory(CWD, true))
    expect(result.current.isFiltering).toBe(false)
    expect(result.current.visible.map((c) => c.shortHash)).toEqual([
      'c3c3c3c',
      'b2b2b2b',
      'a1a1a1a'
    ])
    expect(result.current.layout.rows).toHaveLength(3)
    expect(result.current.rowByHash.get(COMMITS[1].hash)).toBe(1)
    expect(result.current.hasLoaded).toBe(true)
  })

  it('trims and lower-cases the query, so both shells filter the same way', () => {
    const { result } = renderHook(() => useCommitHistory(CWD, true, { query: '  GRACE ' }))
    expect(result.current.isFiltering).toBe(true)
    expect(result.current.visible.map((c) => c.shortHash)).toEqual(['b2b2b2b'])
    expect(result.current.layout.rows).toHaveLength(3)
  })

  it('treats a blank query as no filter and combines the author with the query', () => {
    const blank = renderHook(() => useCommitHistory(CWD, true, { query: '   ' }))
    expect(blank.result.current.isFiltering).toBe(false)

    const byAuthor = renderHook(() => useCommitHistory(CWD, true, { author: 'Ada', query: 'init' }))
    expect(byAuthor.result.current.visible.map((c) => c.shortHash)).toEqual(['a1a1a1a'])
  })

  it('fetches on first reveal only, and refresh reads again', async () => {
    useGitHistoryStore.setState({ commits: {} })
    const { result, rerender } = renderHook(({ visible }) => useCommitHistory(CWD, visible), {
      initialProps: { visible: false }
    })
    expect(getLog).not.toHaveBeenCalled()
    expect(result.current.hasLoaded).toBe(false)
    expect(result.current.commits).toEqual([])

    rerender({ visible: true })
    expect(getLog).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(result.current.hasLoaded).toBe(true))
    rerender({ visible: true })
    expect(getLog).toHaveBeenCalledTimes(1)

    result.current.refresh()
    expect(getLog).toHaveBeenCalledTimes(2)
  })
})
