import type { GitCommitDetail } from '@shared/types/ipc.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getLog, getCommitDetail } = vi.hoisted(() => ({
  getLog: vi.fn(),
  getCommitDetail: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/git-api', () => ({ gitApi: { getLog, getCommitDetail } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { commitDetailKey, GIT_LOG_LIMIT, useGitHistoryStore } from './git-history-store'

const CWD = '/repo'
const hash = (n: number): string => String(n).padStart(40, '0')
const detail = (h: string): GitCommitDetail => ({
  hash: h,
  authorEmail: '',
  message: '',
  parents: [],
  files: [],
  filesTruncated: false
})
const state = () => useGitHistoryStore.getState()

describe('git-history-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useGitHistoryStore.setState({
      commits: {},
      loading: {},
      error: {},
      scope: {},
      details: {},
      headSummary: {}
    })
    getCommitDetail.mockImplementation(async (_cwd: string, h: string) => detail(h))
  })

  it('reads the log with the shared limit and the scope', async () => {
    getLog.mockResolvedValue([])
    await state().refreshLog(CWD)
    expect(getLog).toHaveBeenLastCalledWith(CWD, GIT_LOG_LIMIT, true)
    useGitHistoryStore.setState({ scope: { [CWD]: 'head' } })
    await state().refreshLog(CWD)
    expect(getLog).toHaveBeenLastCalledWith(CWD, GIT_LOG_LIMIT, false)
  })

  describe('commit detail cache', () => {
    it('keeps at most 50 entries and evicts the oldest first', async () => {
      for (let n = 1; n <= 55; n++) await state().loadCommitDetail(CWD, hash(n))
      const keys = Object.keys(state().details)
      expect(keys).toHaveLength(50)
      expect(state().details[commitDetailKey(CWD, hash(5))]).toBeUndefined()
      expect(state().details[commitDetailKey(CWD, hash(6))]?.detail).not.toBeNull()
      expect(state().details[commitDetailKey(CWD, hash(55))]?.detail).not.toBeNull()
    })

    it('treats a hit as a use, so a re-read entry outlives older ones', async () => {
      for (let n = 1; n <= 50; n++) await state().loadCommitDetail(CWD, hash(n))
      await state().loadCommitDetail(CWD, hash(1))
      await state().loadCommitDetail(CWD, hash(51))
      expect(state().details[commitDetailKey(CWD, hash(1))]).toBeDefined()
      expect(state().details[commitDetailKey(CWD, hash(2))]).toBeUndefined()
      expect(getCommitDetail).toHaveBeenCalledTimes(51)
    })
  })

  describe('refreshHeadSummary', () => {
    it('reads from HEAD and leaves the History tab state alone', async () => {
      useGitHistoryStore.setState({ scope: { [CWD]: 'all' } })
      getLog.mockResolvedValue([{ hash: hash(2) }, { hash: hash(1) }])
      await state().refreshHeadSummary(CWD)
      expect(getLog).toHaveBeenCalledWith(CWD, GIT_LOG_LIMIT, false)
      expect(state().headSummary[CWD]).toEqual({ last: { hash: hash(2) }, count: 2 })
      expect(state().commits[CWD]).toBeUndefined()
      expect(state().loading[CWD]).toBeUndefined()
      expect(state().scope[CWD]).toBe('all')
    })

    it('keeps the previous summary when a later read fails', async () => {
      getLog.mockResolvedValueOnce([{ hash: hash(1) }])
      await state().refreshHeadSummary(CWD)
      getLog.mockRejectedValueOnce(new Error('boom'))
      await state().refreshHeadSummary(CWD)
      expect(state().headSummary[CWD]?.count).toBe(1)
    })

    it('drops a superseded response', async () => {
      let release: (value: unknown) => void = () => undefined
      getLog.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
      const slow = state().refreshHeadSummary(CWD)
      getLog.mockResolvedValueOnce([{ hash: hash(2) }, { hash: hash(1) }])
      await state().refreshHeadSummary(CWD)
      release([{ hash: hash(9) }])
      await slow
      expect(state().headSummary[CWD]?.count).toBe(2)
    })
  })
})
