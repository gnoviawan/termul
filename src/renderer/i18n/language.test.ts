import { describe, expect, it } from 'vitest'
import {
  isUiLanguagePreference,
  resolveLanguagePreference,
  resolveSystemLanguage
} from './language'

describe('i18n language resolution', () => {
  it('preserves explicit supported preferences', () => {
    expect(resolveLanguagePreference('en', ['zh-CN'])).toBe('en')
    expect(resolveLanguagePreference('zh-CN', ['en-US'])).toBe('zh-CN')
  })

  it('maps supported system locales and falls back to English', () => {
    expect(resolveSystemLanguage(['zh-Hans-SG', 'en-US'])).toBe('zh-CN')
    expect(resolveSystemLanguage(['zh-TW'])).toBe('en')
    expect(resolveSystemLanguage(['fr-FR'])).toBe('en')
  })

  it('validates persisted preferences', () => {
    expect(isUiLanguagePreference('system')).toBe(true)
    expect(isUiLanguagePreference('zh-CN')).toBe(true)
    expect(isUiLanguagePreference('zh-TW')).toBe(false)
  })
})
