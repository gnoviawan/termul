import type {
  GithubCheckLogRequest,
  GithubCheckoutPrRequest,
  GithubChecksRequest,
  GithubCommentRequest,
  GithubItemRequest,
  GithubListRequest,
  GithubMergeRequest
} from '@shared/types/github.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvoke, mockIsTauriContext, mockLog } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockIsTauriContext: vi.fn(),
  mockLog: vi.fn()
}))

vi.mock('./tauri-runtime', () => ({ isTauriContext: mockIsTauriContext }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))
vi.mock('./log-api', () => ({ logFrontendError: mockLog }))

import { githubApi } from './github-api'

const cwd = '/home/me/termul'
const listRequest: GithubListRequest = {
  cwd,
  filter: {
    repo: 'upstream',
    kind: 'pr',
    state: 'open',
    assignedToMe: false,
    reviewRequested: true
  },
  refresh: true
}
const itemRequest: GithubItemRequest = { cwd, repo: 'origin', kind: 'pr', number: 42 }
const checksRequest: GithubChecksRequest = { cwd, repo: 'origin', number: 42 }
const logRequest: GithubCheckLogRequest = { cwd, repo: 'origin', jobId: 124217788236 }
const mergeRequest: GithubMergeRequest = {
  cwd,
  repo: 'origin',
  number: 42,
  action: { kind: 'merge', method: 'squash' }
}

const commentRequest: GithubCommentRequest = {
  cwd,
  repo: 'origin',
  kind: 'pr',
  number: 42,
  target: { kind: 'review_thread', threadId: 'PRRT_kwDO1' },
  body: 'Fixed in the latest push.'
}
const checkoutRequest: GithubCheckoutPrRequest = {
  cwd: `${cwd}/.termul/worktrees/abc`,
  repo: 'upstream',
  number: 42
}

const cases = [
  {
    call: () => githubApi.getContext(cwd),
    command: 'github_get_context',
    route: '/github/context',
    request: { cwd }
  },
  {
    call: () => githubApi.listItems(listRequest),
    command: 'github_list_items',
    route: '/github/items',
    request: listRequest
  },
  {
    call: () => githubApi.getItem(itemRequest),
    command: 'github_get_item',
    route: '/github/item',
    request: itemRequest
  },
  {
    call: () => githubApi.getChecks(checksRequest),
    command: 'github_get_checks',
    route: '/github/checks',
    request: checksRequest
  },
  {
    call: () => githubApi.getCheckLog(logRequest),
    command: 'github_get_check_log',
    route: '/github/check-log',
    request: logRequest
  },
  {
    call: () => githubApi.merge(mergeRequest),
    command: 'github_merge',
    route: '/github/merge',
    request: mergeRequest
  },
  {
    call: () => githubApi.comment(commentRequest),
    command: 'github_comment',
    route: '/github/comment',
    request: commentRequest
  },
  {
    call: () => githubApi.checkoutPr(checkoutRequest),
    command: 'github_checkout_pr',
    route: '/github/checkout-pr',
    request: checkoutRequest
  }
]

const fetchMock = vi.fn()

describe('githubApi', () => {
  beforeEach(() => {
    mockInvoke.mockReset()
    mockIsTauriContext.mockReset()
    mockLog.mockReset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { location: { origin: 'http://localhost:8080' } })
  })

  it.each(cases)('desktop invokes $command with { request }', async ({
    call,
    command,
    request
  }) => {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce({ success: true, data: { marker: command } })

    const result = await call()

    expect(mockInvoke).toHaveBeenCalledWith(command, { request })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, data: { marker: command } })
  })

  it.each(cases)('web POSTs $route with the request as the body', async ({
    call,
    route,
    request
  }) => {
    mockIsTauriContext.mockReturnValue(false)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { marker: route } })
    })

    const result = await call()

    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:8080${route}`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) })
    )
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, data: { marker: route } })
  })

  it('a failed op is returned as-is and logged with its code, not its message', async () => {
    mockIsTauriContext.mockReturnValue(true)
    const failure = {
      success: false,
      error: 'gh is not signed in to github.com',
      code: 'GH_UNAUTHENTICATED'
    }
    mockInvoke.mockResolvedValueOnce(failure)

    const result = await githubApi.listItems(listRequest)

    expect(result).toEqual(failure)
    expect(mockLog).toHaveBeenCalledWith({
      level: 'warn',
      source: 'github-api.github_list_items',
      message: 'github_list_items failed (code=GH_UNAUTHENTICATED)'
    })
  })
})
