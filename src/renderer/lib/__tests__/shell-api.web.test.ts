/**
 * Web-branch tests for shell-api.ts.
 *
 * `getAvailableShells` branches on `isTauriContext()`: desktop calls
 * `invoke('detect_shells')` (with a frontend cache + dedupe); web/remote
 * calls `webServerShell.getAvailableShells()` (GET /shells) and bypasses the
 * cache (each call hits the server). This file covers both branches.
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

import { _resetShellCacheForTesting, shellApi } from '../shell-api'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body)
  } as unknown as Response
}

const detectedShells = {
  default: { name: 'powershell', path: 'C:/pwsh', displayName: 'PowerShell' },
  available: [{ name: 'powershell', path: 'C:/pwsh', displayName: 'PowerShell' }]
}

describe('shellApi.getAvailableShells (web vs desktop branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetShellCacheForTesting()
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('delegates to webServerShell (GET /shells) when !isTauriContext()', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: detectedShells }))

    const result = await shellApi.getAvailableShells()

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual(detectedShells)
    }
    expect(mockFetch).toHaveBeenCalledWith(
      `${window.location.origin}/shells`,
      expect.objectContaining({ method: 'GET' })
    )
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('does NOT cache across calls in web mode (each call hits the server)', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: detectedShells }))

    await shellApi.getAvailableShells()
    await shellApi.getAvailableShells()

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('maps a server failure body to a failed IpcResult in web mode', async () => {
    mockIsTauriContext.mockReturnValue(false)
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: 'detect failed', code: 'SHELL_DETECT_ERROR' })
    )

    const result = await shellApi.getAvailableShells()

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('SHELL_DETECT_ERROR')
    }
  })

  it('calls invoke("detect_shells") on the desktop path', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce(detectedShells)

    const result = await shellApi.getAvailableShells()

    expect(result.success).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith('detect_shells', undefined)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
