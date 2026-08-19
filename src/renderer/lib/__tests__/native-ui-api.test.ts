/**
 * Parity tests for native-ui-api.ts `syncNativeUiLanguage`.
 *
 * Asserts:
 * - non-Tauri path: returns early, does not invoke Tauri or log a failure,
 * - Tauri path: invokes `set_native_ui_language` with the requested language,
 * - Tauri path: an invoke rejection is reported through `logFrontendError`
 *   (and does not throw to the caller).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsTauriContext, mockInvoke, mockLogFrontendError } = vi.hoisted(() => ({
  mockIsTauriContext: vi.fn(),
  mockInvoke: vi.fn(),
  mockLogFrontendError: vi.fn()
}))

vi.mock('../tauri-runtime', () => ({
  cleanupTauriListener: vi.fn(),
  isTauriContext: mockIsTauriContext
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

vi.mock('../log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

import { syncNativeUiLanguage } from '../native-ui-api'

describe('syncNativeUiLanguage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue(undefined)
    mockLogFrontendError.mockResolvedValue(undefined)
  })

  it('skips Tauri invoke and logging on the non-Tauri (web) path', async () => {
    mockIsTauriContext.mockReturnValue(false)

    await syncNativeUiLanguage('en')

    expect(mockInvoke).not.toHaveBeenCalled()
    expect(mockLogFrontendError).not.toHaveBeenCalled()
  })

  it('invokes set_native_ui_language with the requested language on Tauri', async () => {
    mockIsTauriContext.mockReturnValue(true)

    await syncNativeUiLanguage('zh-CN')

    expect(mockInvoke).toHaveBeenCalledWith('set_native_ui_language', {
      language: 'zh-CN'
    })
    expect(mockLogFrontendError).not.toHaveBeenCalled()
  })

  it('reports an invoke rejection through logFrontendError without throwing', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockInvoke.mockRejectedValue(new Error('boom'))

    await expect(syncNativeUiLanguage('en')).resolves.toBeUndefined()

    expect(mockInvoke).toHaveBeenCalledWith('set_native_ui_language', {
      language: 'en'
    })
    expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
    const payload = mockLogFrontendError.mock.calls[0]?.[0]
    expect(payload).toMatchObject({ level: 'warn', source: 'native-ui-language' })
    expect(typeof payload.message).toBe('string')
    expect(payload.message).toContain('boom')
  })
})
