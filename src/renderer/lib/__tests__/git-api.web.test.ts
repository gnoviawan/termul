/**
 * Web-branch tests for git-api.ts.
 *
 * `gitApi.init` branches on `isTauriContext()`: desktop calls
 * `invoke('git_init', { cwd })`; web/remote calls `webServerGit.init(cwd)`
 * (POST /git/init). This file covers both branches of that single method;
 * the other gitApi methods are desktop-only and out of scope.
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

describe('gitApi.init (web vs desktop branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('delegates to webServerGit.init (POST /git/init) when !isTauriContext()', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))

    await gitApi.init('/web/proj')

    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/git/init`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ cwd: '/web/proj' })
      })
    )
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('throws when the web server reports GIT_INIT_ERROR', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'git missing', code: 'GIT_INIT_ERROR' })
    )

    await expect(gitApi.init('/web/proj')).rejects.toThrow('git missing')
  })

  it('calls invoke("git_init", { cwd }) on the desktop path', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce(undefined)

    await gitApi.init('/desktop/proj')

    expect(mockInvoke).toHaveBeenCalledWith('git_init', { cwd: '/desktop/proj' })
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
