/**
 * Web-branch tests for git-api.ts (CAP-1: Web & Mobile 1:1 Parity).
 *
 * Every `gitApi` method now branches on `isTauriContext()` between the desktop
 * `invoke(...)` path and the same-origin `webServerGit.*` HTTP impl. This file
 * asserts, one method at a time, that:
 * - the WEB branch calls `fetch` (POST /git/*) and NOT `invoke`
 * - the DESKTOP branch calls `invoke` and NOT `fetch`
 *
 * The web path returns `IpcBody<T>` (`{ success, data } | { success, error, code }`);
 * the facade unwraps it and throws on `!res.success`, mirroring the `invoke`
 * rejection shape desktop callers already see.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch, mockIsTauriContext, mockInvoke } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockIsTauriContext: vi.fn(),
  mockInvoke: vi.fn()
}))

vi.mock('../tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

import { gitApi } from '../git-api'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body)
  } as unknown as Response
}

const CWD = '/web/proj'

describe('gitApi (web vs desktop branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Helper: assert the WEB branch fires fetch (not invoke) and the fetch call
  // target matches the expected method/path/body.
  async function expectWebCall(
    fn: () => Promise<unknown>,
    expectedPath: string,
    expectedBodyMethod: 'POST' | 'GET',
    expectedBody: unknown,
    response: unknown
  ): Promise<void> {
    mockIsTauriContext.mockReturnValue(false)
    mockFetch.mockResolvedValueOnce(jsonResponse(response))
    await fn()
    if (expectedBodyMethod === 'POST') {
      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}${expectedPath}`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(expectedBody)
        })
      )
    } else {
      expect(mockFetch).toHaveBeenCalledWith(
        `${window.location.origin}${expectedPath}`,
        expect.objectContaining({ method: 'GET' })
      )
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  }

  // Helper: assert the DESKTOP branch fires invoke (not fetch) with the
  // expected command + args.
  async function expectDesktopCall(
    fn: () => Promise<unknown>,
    expectedCommand: string,
    expectedArgs: Record<string, unknown>
  ): Promise<void> {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce(undefined)
    await fn()
    expect(mockInvoke).toHaveBeenCalledWith(expectedCommand, expectedArgs)
    expect(mockFetch).not.toHaveBeenCalled()
  }

  // ---- getStatus ----
  it('getStatus: web → POST /git/status', async () => {
    await expectWebCall(
      () => gitApi.getStatus(CWD),
      '/git/status',
      'POST',
      { cwd: CWD },
      { success: true, data: [] }
    )
  })
  it('getStatus: desktop → invoke("git_get_status")', async () => {
    await expectDesktopCall(() => gitApi.getStatus(CWD), 'git_get_status', { cwd: CWD })
  })

  // ---- getDiff ----
  it('getDiff: web → POST /git/diff', async () => {
    await expectWebCall(
      () => gitApi.getDiff(CWD, 'a.txt', true),
      '/git/diff',
      'POST',
      { cwd: CWD, path: 'a.txt', staged: true },
      { success: true, data: 'diff body' }
    )
  })
  it('getDiff: desktop → invoke("git_get_diff")', async () => {
    await expectDesktopCall(() => gitApi.getDiff(CWD, 'a.txt', false), 'git_get_diff', {
      cwd: CWD,
      path: 'a.txt',
      staged: false
    })
  })

  // ---- stage ----
  it('stage: web → POST /git/stage', async () => {
    await expectWebCall(
      () => gitApi.stage(CWD, 'a.txt'),
      '/git/stage',
      'POST',
      { cwd: CWD, path: 'a.txt' },
      { success: true }
    )
  })
  it('stage: desktop → invoke("git_stage")', async () => {
    await expectDesktopCall(() => gitApi.stage(CWD, 'a.txt'), 'git_stage', {
      cwd: CWD,
      path: 'a.txt'
    })
  })

  // ---- unstage ----
  it('unstage: web → POST /git/unstage', async () => {
    await expectWebCall(
      () => gitApi.unstage(CWD, 'a.txt'),
      '/git/unstage',
      'POST',
      { cwd: CWD, path: 'a.txt' },
      { success: true }
    )
  })
  it('unstage: desktop → invoke("git_unstage")', async () => {
    await expectDesktopCall(() => gitApi.unstage(CWD, 'a.txt'), 'git_unstage', {
      cwd: CWD,
      path: 'a.txt'
    })
  })

  // ---- discard ----
  it('discard: web → POST /git/discard', async () => {
    await expectWebCall(
      () => gitApi.discard(CWD, 'a.txt'),
      '/git/discard',
      'POST',
      { cwd: CWD, path: 'a.txt' },
      { success: true }
    )
  })
  it('discard: desktop → invoke("git_discard")', async () => {
    await expectDesktopCall(() => gitApi.discard(CWD, 'a.txt'), 'git_discard', {
      cwd: CWD,
      path: 'a.txt'
    })
  })

  // ---- getLog ----
  it('getLog: web → POST /git/log', async () => {
    await expectWebCall(
      () => gitApi.getLog(CWD, 5),
      '/git/log',
      'POST',
      { cwd: CWD, limit: 5 },
      { success: true, data: [] }
    )
  })
  it('getLog: desktop → invoke("git_get_log")', async () => {
    await expectDesktopCall(() => gitApi.getLog(CWD), 'git_get_log', { cwd: CWD, limit: undefined })
  })

  // ---- commit ----
  it('commit: web → POST /git/commit', async () => {
    await expectWebCall(
      () => gitApi.commit(CWD, 'summary', 'desc', true),
      '/git/commit',
      'POST',
      { cwd: CWD, summary: 'summary', description: 'desc', amend: true },
      { success: true }
    )
  })
  it('commit: desktop → invoke("git_commit")', async () => {
    await expectDesktopCall(() => gitApi.commit(CWD, 'summary', 'desc', true), 'git_commit', {
      cwd: CWD,
      summary: 'summary',
      description: 'desc',
      amend: true
    })
  })

  // ---- push ----
  it('push: web → POST /git/push', async () => {
    await expectWebCall(
      () => gitApi.push(CWD),
      '/git/push',
      'POST',
      { cwd: CWD },
      { success: true }
    )
  })
  it('push: desktop → invoke("git_push")', async () => {
    await expectDesktopCall(() => gitApi.push(CWD), 'git_push', { cwd: CWD })
  })

  // ---- getCommitContext ----
  it('getCommitContext: web → POST /git/commit-context', async () => {
    await expectWebCall(
      () => gitApi.getCommitContext(CWD),
      '/git/commit-context',
      'POST',
      { cwd: CWD },
      { success: true, data: { hasHead: false } }
    )
  })
  it('getCommitContext: desktop → invoke("git_get_commit_context")', async () => {
    await expectDesktopCall(() => gitApi.getCommitContext(CWD), 'git_get_commit_context', {
      cwd: CWD
    })
  })

  // ---- init ----
  it('init: web → POST /git/init', async () => {
    await expectWebCall(
      () => gitApi.init(CWD),
      '/git/init',
      'POST',
      { cwd: CWD },
      { success: true }
    )
  })
  it('init: desktop → invoke("git_init")', async () => {
    await expectDesktopCall(() => gitApi.init(CWD), 'git_init', { cwd: CWD })
  })

  // ---- checkoutBranch ----
  it('checkoutBranch: web → POST /git/checkout-branch', async () => {
    await expectWebCall(
      () => gitApi.checkoutBranch(CWD, 'main', true),
      '/git/checkout-branch',
      'POST',
      { cwd: CWD, branch: 'main', isRemote: true },
      { success: true }
    )
  })
  it('checkoutBranch: desktop → invoke("git_checkout_branch")', async () => {
    await expectDesktopCall(
      () => gitApi.checkoutBranch(CWD, 'main', false),
      'git_checkout_branch',
      {
        cwd: CWD,
        branch: 'main',
        isRemote: false
      }
    )
  })

  // ---- createBranch ----
  it('createBranch: web → POST /git/create-branch', async () => {
    await expectWebCall(
      () => gitApi.createBranch(CWD, 'feature', 'HEAD'),
      '/git/create-branch',
      'POST',
      { cwd: CWD, branch: 'feature', startRef: 'HEAD' },
      { success: true }
    )
  })
  it('createBranch: desktop → invoke("git_create_branch")', async () => {
    await expectDesktopCall(() => gitApi.createBranch(CWD, 'feature'), 'git_create_branch', {
      cwd: CWD,
      branch: 'feature',
      startRef: undefined
    })
  })

  // ---- stashSave ----
  it('stashSave: web → POST /git/stash-save', async () => {
    await expectWebCall(
      () => gitApi.stashSave(CWD, 'msg', true),
      '/git/stash-save',
      'POST',
      { cwd: CWD, message: 'msg', includeUntracked: true },
      { success: true }
    )
  })
  it('stashSave: desktop → invoke("git_stash_save")', async () => {
    await expectDesktopCall(() => gitApi.stashSave(CWD, 'msg', true), 'git_stash_save', {
      cwd: CWD,
      message: 'msg',
      includeUntracked: true
    })
  })

  // ---- stashList ----
  it('stashList: web → GET /git/stash-list', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }))
    await gitApi.stashList(CWD)
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/git/stash-list?cwd=${encodeURIComponent(CWD)}`,
      expect.objectContaining({ method: 'GET' })
    )
    expect(mockInvoke).not.toHaveBeenCalled()
  })
  it('stashList: desktop → invoke("git_stash_list")', async () => {
    await expectDesktopCall(() => gitApi.stashList(CWD), 'git_stash_list', { cwd: CWD })
  })

  // ---- stashApply ----
  it('stashApply: web → POST /git/stash-apply', async () => {
    await expectWebCall(
      () => gitApi.stashApply(CWD, 1),
      '/git/stash-apply',
      'POST',
      { cwd: CWD, index: 1 },
      { success: true }
    )
  })
  it('stashApply: desktop → invoke("git_stash_apply")', async () => {
    await expectDesktopCall(() => gitApi.stashApply(CWD, 1), 'git_stash_apply', {
      cwd: CWD,
      index: 1
    })
  })

  // ---- stashPop ----
  it('stashPop: web → POST /git/stash-pop', async () => {
    await expectWebCall(
      () => gitApi.stashPop(CWD, 1),
      '/git/stash-pop',
      'POST',
      { cwd: CWD, index: 1 },
      { success: true }
    )
  })
  it('stashPop: desktop → invoke("git_stash_pop")', async () => {
    await expectDesktopCall(() => gitApi.stashPop(CWD, 1), 'git_stash_pop', { cwd: CWD, index: 1 })
  })

  // ---- stashDrop ----
  it('stashDrop: web → POST /git/stash-drop', async () => {
    await expectWebCall(
      () => gitApi.stashDrop(CWD, 1),
      '/git/stash-drop',
      'POST',
      { cwd: CWD, index: 1 },
      { success: true }
    )
  })
  it('stashDrop: desktop → invoke("git_stash_drop")', async () => {
    await expectDesktopCall(() => gitApi.stashDrop(CWD, 1), 'git_stash_drop', {
      cwd: CWD,
      index: 1
    })
  })

  // ---- branchList ----
  it('branchList: web → GET /git/branch-list', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: ['main'] }))
    await gitApi.branchList(CWD)
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/git/branch-list?cwd=${encodeURIComponent(CWD)}`,
      expect.objectContaining({ method: 'GET' })
    )
    expect(mockInvoke).not.toHaveBeenCalled()
  })
  it('branchList: desktop → invoke("git_branch_list")', async () => {
    await expectDesktopCall(() => gitApi.branchList(CWD), 'git_branch_list', { cwd: CWD })
  })

  // ---- branchSwitch ----
  it('branchSwitch: web → POST /git/branch-switch', async () => {
    await expectWebCall(
      () => gitApi.branchSwitch(CWD, 'main'),
      '/git/branch-switch',
      'POST',
      { cwd: CWD, name: 'main' },
      { success: true }
    )
  })
  it('branchSwitch: desktop → invoke("git_branch_switch")', async () => {
    await expectDesktopCall(() => gitApi.branchSwitch(CWD, 'main'), 'git_branch_switch', {
      cwd: CWD,
      name: 'main'
    })
  })

  // ---- branchCreate ----
  it('branchCreate: web → POST /git/branch-create', async () => {
    await expectWebCall(
      () => gitApi.branchCreate(CWD, 'feature'),
      '/git/branch-create',
      'POST',
      { cwd: CWD, name: 'feature' },
      { success: true }
    )
  })
  it('branchCreate: desktop → invoke("git_branch_create")', async () => {
    await expectDesktopCall(() => gitApi.branchCreate(CWD, 'feature'), 'git_branch_create', {
      cwd: CWD,
      name: 'feature'
    })
  })

  it('web branch throws on IpcBody error (status method)', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'boom', code: 'GIT_STATUS_ERROR' })
    )
    await expect(gitApi.getStatus(CWD)).rejects.toThrow('boom')
  })

  it('web branch returns unwrapped data on success (getLog)', async () => {
    mockIsTauriContext.mockReturnValue(false)
    const commits = [{ hash: 'a', shortHash: 'a' } as unknown]
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: commits }))
    const result = await gitApi.getLog(CWD)
    expect(result).toBe(commits)
  })
})
