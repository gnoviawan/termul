import { beforeEach, describe, expect, it, vi } from 'vitest'

const { read } = vi.hoisted(() => ({
  read: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: { read }
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

import { initializeI18nFromSettings } from './bootstrap'
import { i18n } from './index'

describe('i18n bootstrap', () => {
  beforeEach(() => {
    read.mockReset()
    Object.defineProperty(window.navigator, 'languages', {
      configurable: true,
      value: ['en-US']
    })
  })

  it('applies a persisted explicit language before returning', async () => {
    read.mockResolvedValue({ success: true, data: { uiLanguage: 'zh-CN' } })

    await initializeI18nFromSettings()

    expect(i18n.resolvedLanguage).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
  })

  it('uses the supported system language for system preference', async () => {
    Object.defineProperty(window.navigator, 'languages', {
      configurable: true,
      value: ['zh-Hans-CN']
    })
    read.mockResolvedValue({ success: true, data: { uiLanguage: 'system' } })

    await initializeI18nFromSettings()

    expect(i18n.resolvedLanguage).toBe('zh-CN')
  })
})
