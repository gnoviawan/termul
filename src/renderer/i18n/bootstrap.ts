import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { APP_SETTINGS_KEY } from '@/types/settings'
import { initializeI18n } from './index'
import {
  getBrowserLanguages,
  isUiLanguagePreference,
  resolveLanguagePreference,
  type UiLanguagePreference
} from './language'

const SETTINGS_READ_TIMEOUT_MS = 750

type PersistedLanguageSettings = {
  uiLanguage?: unknown
}

async function readPersistedLanguagePreference(): Promise<UiLanguagePreference> {
  const timeout = new Promise<null>((resolve) => {
    window.setTimeout(() => resolve(null), SETTINGS_READ_TIMEOUT_MS)
  })

  try {
    const result = await Promise.race([
      persistenceApi.read<PersistedLanguageSettings>(APP_SETTINGS_KEY),
      timeout
    ])

    if (result && result.success && isUiLanguagePreference(result.data?.uiLanguage)) {
      return result.data.uiLanguage
    }
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: 'i18n.bootstrap',
      message: error instanceof Error ? error.message : String(error)
    })
  }

  return 'system'
}

export async function initializeI18nFromSettings(): Promise<void> {
  const preference = await readPersistedLanguagePreference()
  await initializeI18n(resolveLanguagePreference(preference, getBrowserLanguages()))
}
