import i18next from 'i18next'
import { describe, expect, it } from 'vitest'
import { i18n, initializeI18n } from './index'

describe('i18n core', () => {
  it('supports interpolation and plurals in English and Chinese', async () => {
    await initializeI18n('en')
    expect(i18n.t('examples.greeting', { name: 'Ada' })).toBe('Hello, Ada')
    expect(i18n.t('examples.itemCount', { count: 2, formattedCount: '2' })).toBe('2 items')
    expect(document.documentElement.lang).toBe('en')
    expect(document.title).toBe('Termul Manager — Project-Aware Terminal')

    await initializeI18n('zh-CN')
    expect(i18n.t('examples.greeting', { name: 'Ada' })).toBe('你好，Ada')
    expect(i18n.t('examples.itemCount', { count: 2, formattedCount: '2' })).toBe('2 项')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(document.title).toBe('Termul 管理器 — 项目感知终端')
  })

  it('falls back to English when a Chinese key is missing', async () => {
    const instance = i18next.createInstance()
    await instance.init({
      lng: 'zh-CN',
      fallbackLng: 'en',
      resources: {
        en: { common: { onlyEnglish: 'English fallback' } },
        'zh-CN': { common: {} }
      },
      defaultNS: 'common'
    })

    expect(instance.t('onlyEnglish')).toBe('English fallback')
  })
})
