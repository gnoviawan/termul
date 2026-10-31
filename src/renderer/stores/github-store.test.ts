import type { GithubListItem, GithubListResult } from '@shared/types/github.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getContext: vi.fn(),
  listItems: vi.fn(),
  getItem: vi.fn(),
  getChecks: vi.fn(),
  getCheckLog: vi.fn(),
  merge: vi.fn()
}))

vi.mock('@/lib/github-api', () => ({ githubApi: api }))

import { DEFAULT_GITHUB_FILTER, githubListKey, useGithubStore } from './github-store'

const CWD = '/repo'
const REPO = { host: 'github.com', owner: 'acme', name: 'app' }

function item(number: number, title: string): GithubListItem {
  return {
    kind: 'issue',
    number,
    title,
    state: 'open',
    author: 'ana',
    labels: [],
    assignees: [],
    commentCount: 0,
    updatedAt: '2026-10-30T10:00:00Z',
    url: `https://github.com/acme/app/issues/${number}`,
    checks: null
  }
}

function listResult(...items: GithubListItem[]): GithubListResult {
  return { repo: REPO, items, fetchedAt: '2026-10-31T10:00:00Z' }
}

const ok = <T>(data: T) => ({ success: true as const, data })
const fail = (code: string, error = 'boom') => ({ success: false as const, code, error })

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const state = () => useGithubStore.getState()
const defaultList = () => state().lists[githubListKey(CWD, DEFAULT_GITHUB_FILTER)]

describe('github-store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useGithubStore.setState({
      contexts: {},
      lists: {},
      items: {},
      checks: {},
      logs: {},
      filters: {}
    })
  })

  it('keeps the last good list visible when a refresh is rate limited', async () => {
    api.listItems.mockResolvedValueOnce(ok(listResult(item(1, 'First'))))
    await state().loadList(CWD)
    api.listItems.mockResolvedValueOnce(fail('GH_RATE_LIMITED', 'rate limited'))
    await state().loadList(CWD, { refresh: true })

    expect(defaultList()).toEqual({
      data: listResult(item(1, 'First')),
      status: 'error',
      errorCode: 'GH_RATE_LIMITED',
      error: 'rate limited'
    })
    expect(api.listItems).toHaveBeenLastCalledWith({
      cwd: CWD,
      filter: DEFAULT_GITHUB_FILTER,
      refresh: true
    })
  })

  it('ignores a slower, older response that lands after a newer one', async () => {
    const slow = deferred<ReturnType<typeof ok<GithubListResult>>>()
    api.listItems.mockReturnValueOnce(slow.promise)
    api.listItems.mockResolvedValueOnce(ok(listResult(item(2, 'Newer'))))

    const first = state().loadList(CWD)
    await state().loadList(CWD, { refresh: true })
    slow.resolve(ok(listResult(item(1, 'Older'))))
    await first

    expect(defaultList()?.data?.items.map((i) => i.title)).toEqual(['Newer'])
    expect(defaultList()?.status).toBe('idle')
  })

  it('refetches with the new filter when a filter changes', async () => {
    api.listItems.mockResolvedValue(ok(listResult()))
    state().setFilter(CWD, { kind: 'pr', reviewRequested: true })
    await vi.waitFor(() => expect(api.listItems).toHaveBeenCalledTimes(1))

    expect(api.listItems).toHaveBeenCalledWith({
      cwd: CWD,
      filter: { ...DEFAULT_GITHUB_FILTER, kind: 'pr', reviewRequested: true },
      refresh: undefined
    })
    state().setFilter(CWD, { state: 'merged' })
    await vi.waitFor(() => expect(api.listItems).toHaveBeenCalledTimes(2))
    expect(api.listItems).toHaveBeenLastCalledWith({
      cwd: CWD,
      filter: { ...DEFAULT_GITHUB_FILTER, kind: 'pr', reviewRequested: true, state: 'merged' },
      refresh: undefined
    })
  })

  it('re-reads the GitHub status when a list read reports the user signed out', async () => {
    api.listItems.mockResolvedValueOnce(fail('GH_UNAUTHENTICATED'))
    api.getContext.mockResolvedValueOnce(
      ok({
        auth: { state: 'unauthenticated', host: 'github.com', loginCommand: 'gh auth login' },
        repo: { kind: 'resolved', origin: REPO, upstream: null }
      })
    )
    await state().loadList(CWD)
    await vi.waitFor(() => expect(state().contexts[CWD]?.data?.auth.state).toBe('unauthenticated'))
    expect(api.getContext).toHaveBeenCalledWith(CWD)
  })

  it('re-reads the PR, its checks and the list past the cache after a merge', async () => {
    api.merge.mockResolvedValueOnce(ok({ number: 7 }))
    api.getItem.mockResolvedValue(fail('GH_FAILED'))
    api.getChecks.mockResolvedValue(fail('GH_FAILED'))
    api.listItems.mockResolvedValue(ok(listResult()))
    const ref = { cwd: CWD, repo: 'origin' as const, kind: 'pr' as const, number: 7 }

    const result = await state().merge(ref, { kind: 'merge', method: 'squash' })

    expect(result).toEqual(ok({ number: 7 }))
    expect(api.merge).toHaveBeenCalledWith({
      cwd: CWD,
      repo: 'origin',
      number: 7,
      action: { kind: 'merge', method: 'squash' }
    })
    expect(api.getItem).toHaveBeenCalledWith({ ...ref, refresh: true })
    expect(api.getChecks).toHaveBeenCalledWith({
      cwd: CWD,
      repo: 'origin',
      number: 7,
      refresh: true
    })
    expect(api.listItems).toHaveBeenCalledWith({
      cwd: CWD,
      filter: DEFAULT_GITHUB_FILTER,
      refresh: true
    })
  })
})
