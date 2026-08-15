/**
 * Web-branch tests for ssh-api.ts.
 *
 * Pins `isTauriContext()` to FALSE and asserts the SSH facade returns an
 * explicit `WEB_UNSUPPORTED` result for representative command methods
 * (profile listing, connect, SFTP, askpass) instead of invoking the
 * stubbed `@tauri-apps/api/core` `invoke()` (which throws `tauriUnavailable`
 * on web). The desktop path is covered by direct invoke assertions in
 * sibling tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'

const { mockIsTauriContext, mockInvoke } = vi.hoisted(() => ({
  mockIsTauriContext: vi.fn(),
  mockInvoke: vi.fn()
}))

vi.mock('../tauri-runtime', () => ({
  cleanupTauriListener: vi.fn(),
  isTauriContext: mockIsTauriContext
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

import { createAskpassScript, createSSHApi } from '../ssh-api'

describe('sshApi (web branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauriContext.mockReturnValue(false)
    mockInvoke.mockReset()
  })

  it('listProfiles returns a localized WEB_UNSUPPORTED result when !isTauriContext()', async () => {
    const previousLanguage = i18n.language
    const api = createSSHApi()
    try {
      await i18n.changeLanguage('en')
      const englishResult = await api.listProfiles()
      expect(englishResult.success).toBe(false)
      if (!englishResult.success) {
        expect(englishResult.code).toBe('WEB_UNSUPPORTED')
        expect(englishResult.error).toBe('SSH is not available in the web client')
      }

      await i18n.changeLanguage('zh-CN')
      const chineseResult = await api.listProfiles()
      expect(chineseResult.success).toBe(false)
      if (!chineseResult.success) {
        expect(chineseResult.code).toBe('WEB_UNSUPPORTED')
        expect(chineseResult.error).toBe('Web 客户端不支持 SSH')
      }
    } finally {
      await i18n.changeLanguage(previousLanguage)
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('connect returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const api = createSSHApi()
    const result = await api.connect('profile-1')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('sftpListDir returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const api = createSSHApi()
    const result = await api.sftpListDir('conn-1', '/remote')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('createAskpassScript returns WEB_UNSUPPORTED when !isTauriContext()', async () => {
    const result = await createAskpassScript('secret')

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('WEB_UNSUPPORTED')
    }
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
