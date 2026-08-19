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

/**
 * Initialize i18n for bootstrap, recovering to the default language so the
 * renderer still mounts on a settings/i18n failure instead of staying blank.
 * Failures are logged at the i18n boundary; this only keeps rendering alive.
 */
export async function bootstrapI18n(): Promise<void> {
  try {
    await initializeI18nFromSettings()
  } catch (error) {
    void logFrontendError({
      level: 'error',
      source: 'i18n.bootstrap',
      message: `i18n bootstrap failed; falling back to en: ${error instanceof Error ? error.message : String(error)}`
    })
    await initializeI18n('en').catch(() => {
      // i18n itself is broken — render anyway; logged above.
    })
  }
}
