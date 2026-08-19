export const UI_LANGUAGES = ['en', 'zh-CN'] as const
export const UI_LANGUAGE_PREFERENCES = ['system', ...UI_LANGUAGES] as const

export type UiLanguage = (typeof UI_LANGUAGES)[number]
export type UiLanguagePreference = (typeof UI_LANGUAGE_PREFERENCES)[number]

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === 'string' && UI_LANGUAGES.includes(value as UiLanguage)
}

export function isUiLanguagePreference(value: unknown): value is UiLanguagePreference {
  return (
    typeof value === 'string' && UI_LANGUAGE_PREFERENCES.includes(value as UiLanguagePreference)
  )
}

export function resolveSystemLanguage(languages: readonly string[] = []): UiLanguage {
  for (const language of languages) {
    const normalized = language.replace('_', '-').toLowerCase()

    if (normalized === 'zh-cn' || normalized === 'zh-sg' || normalized === 'zh-hans') {
      return 'zh-CN'
    }
    if (normalized.startsWith('zh-hans-')) {
      return 'zh-CN'
    }
    if (normalized === 'en' || normalized.startsWith('en-')) {
      return 'en'
    }
  }

  return 'en'
}

export function getBrowserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  if (navigator.languages.length > 0) return navigator.languages
  return navigator.language ? [navigator.language] : []
}

export function resolveLanguagePreference(
  preference: UiLanguagePreference,
  systemLanguages: readonly string[] = getBrowserLanguages()
): UiLanguage {
  return preference === 'system' ? resolveSystemLanguage(systemLanguages) : preference
}
