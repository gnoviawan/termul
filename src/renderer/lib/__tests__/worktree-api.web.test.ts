/**
 * Web-branch tests for worktree-api.ts.
 *
 * CAP — Web worktree parity: the 7 launch-flow methods (list, create, remove,
 * branches, checkDirty, resolveBaseBranch, copyIncludeFiles) now branch to
 * `webServerWorktree` (HTTP routes in `web/worktree_api.rs`) when
 * `!isTauriContext()`. The 8 advanced ops (symlinks, parseGitignore, merge,
 * archive/restore, removeAllManaged) STAY `WEB_UNSUPPORTED` on web (deferred —
 * see deferred-work.md).
 *
 * Pins `isTauriContext()` to FALSE and asserts:
 * - The 7 launch-flow methods call `fetch` (HTTP), NOT `invoke`.
 * - The 8 advanced methods still return `WEB_UNSUPPORTED`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsTauriContext, mockInvoke, mockFetch } = vi.hoisted(() => ({
  mockIsTauriContext: vi.fn(),
  mockInvoke: vi.fn(),
  mockFetch: vi.fn()
}))

vi.mock('../tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

// Stub `fetch` so the web branch hits the mock without a real network call.
// The `web-server-api.ts` `postJson`/`getJson` helpers call `fetch(`${serverBase()}${path}`)`.
// In jsdom (no `window.location.origin` for a real server), `serverBase()` returns
// the empty string, so the path is relative — `fetch('/worktree/list')` resolves
// against jsdom's `http://localhost/` origin. The mock captures the call + returns
// a JSON `IpcBody` so `parseBody` succeeds.
vi.stubGlobal('fetch', mockFetch)

import { worktreeApi } from '../worktree-api'

/** Build a fetch Response that resolves to the given `IpcBody` JSON. */
function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body
  } as Response
}

describe('worktreeApi (web branch) — 7 launch-flow methods hit HTTP', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(false)
    mockInvoke.mockReset()
    mockFetch.mockReset()
  })

  it('list hits HTTP (not invoke) when !isTauriContext()', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        success: true,
        data: [{ name: 'main', branch: 'main', path: '/p', headCommit: '' }]
      })
    )
    const result = await worktreeApi.list('/project')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toHaveLength(1)
    }
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]!
    expect(String(url)).toContain('/worktree/list')
    expect((init as RequestInit).method).toBe('POST')
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('create hits HTTP with the params body when !isTauriContext()', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        success: true,
        data: { name: 'wt', branch: 'chat/wt', path: '/p/wt', headCommit: '' }
      })
    )
    const result = await worktreeApi.create({
      projectPath: '/project',
      name: 'wt',
      branch: 'chat/wt',
      isNewBranch: true
    })

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]!
    expect(String(url)).toContain('/worktree/create')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.projectPath).toBe('/project')
    expect(body.branch).toBe('chat/wt')
    expect(body.isNewBranch).toBe(true)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('remove hits HTTP with projectPath + worktreePath + force when !isTauriContext()', async () => {
    mockFetch.mockResolvedValue(okResponse({ success: true, data: null }))
    const result = await worktreeApi.remove('/project', '/wt', true)

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]!
    expect(String(url)).toContain('/worktree/remove')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.worktreePath).toBe('/wt')
    expect(body.force).toBe(true)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('branches hits HTTP GET when !isTauriContext()', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        success: true,
        data: [{ name: 'main', isRemote: false, isCurrent: true, hasOtherWorktree: false }]
      })
    )
    const result = await worktreeApi.branches('/project')

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]!
    expect(String(url)).toContain('/worktree/branches')
    expect(String(url)).toContain(encodeURIComponent('/project'))
    expect((init as RequestInit).method).toBe('GET')
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('checkDirty hits HTTP GET with worktreePath query when !isTauriContext()', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        success: true,
        data: { modified: 0, staged: 0, untracked: 0, hasChanges: false }
      })
    )
    const result = await worktreeApi.checkDirty('/wt')

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]!
    expect(String(url)).toContain('/worktree/check-dirty')
    expect(String(url)).toContain(encodeURIComponent('/wt'))
    expect((init as RequestInit).method).toBe('GET')
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('resolveBaseBranch hits HTTP POST when !isTauriContext()', async () => {
    mockFetch.mockResolvedValue(
      okResponse({
        success: true,
        data: { defaultBase: 'main', currentBranch: 'main', isDetached: false }
      })
    )
    const result = await worktreeApi.resolveBaseBranch('/project')

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.defaultBase).toBe('main')
    }
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]!
    expect(String(url)).toContain('/worktree/resolve-base-branch')
    expect((init as RequestInit).method).toBe('POST')
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('copyIncludeFiles hits HTTP with projectPath + worktreePath when !isTauriContext()', async () => {
    mockFetch.mockResolvedValue(
      okResponse({ success: true, data: { ran: 0, copied: 0, skipped: [] } })
    )
    const result = await worktreeApi.copyIncludeFiles('/project', '/wt')

    expect(result.success).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0]!
    expect(String(url)).toContain('/worktree/copy-include-files')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.projectPath).toBe('/project')
    expect(body.worktreePath).toBe('/wt')
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('HTTP transport failure maps to NETWORK_ERROR', async () => {
    mockFetch.mockRejectedValue(new Error('network down'))
    const result = await worktreeApi.list('/project')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('NETWORK_ERROR')
      expect(result.error).toContain('network down')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})

describe('worktreeApi (web branch) — 8 advanced ops stay WEB_UNSUPPORTED', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(false)
    mockInvoke.mockReset()
    mockFetch.mockReset()
  })

  it('removeAllManaged returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await worktreeApi.removeAllManaged('/project', [])
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('parseGitignore returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await worktreeApi.parseGitignore('/project')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('createSymlinks returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await worktreeApi.createSymlinks('/project', '/wt', ['node_modules'])
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('ensureSymlinks returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await worktreeApi.ensureSymlinks('/project', '/wt', ['node_modules'])
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('archive returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await worktreeApi.archive('/project', '/wt')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('restore returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await worktreeApi.restore('/project', '/archive')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('mergePreview returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await worktreeApi.mergePreview('/wt', 'main')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('mergeExecute returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await worktreeApi.mergeExecute('/wt', 'main')
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
