import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { UiLanguage } from './language'
import { defaultNS, namespaces, resources } from './resources'

function applyDocumentLocalization(language: UiLanguage): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = language
  document.documentElement.dir = 'ltr'
  document.title = i18n.t('app.documentTitle', {
    ns: 'common',
    defaultValue: 'Termul Manager'
  })
}

export async function initializeI18n(language: UiLanguage): Promise<typeof i18n> {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      resources,
      lng: language,
      supportedLngs: ['en', 'zh-CN'],
      fallbackLng: 'en',
      defaultNS,
      ns: namespaces,
      load: 'currentOnly',
      returnNull: false,
      returnEmptyString: false,
      interpolation: {
        escapeValue: false
      },
      react: {
        useSuspense: false
      }
    })
  } else if (i18n.resolvedLanguage !== language) {
    await i18n.changeLanguage(language)
  }

  applyDocumentLocalization(language)
  return i18n
}

export async function changeUiLanguage(language: UiLanguage): Promise<void> {
  await initializeI18n(language)
  applyDocumentLocalization(language)
}

export { i18n }
