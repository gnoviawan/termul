import { useEffect } from 'react'
import { changeUiLanguage } from '@/i18n'
import { getBrowserLanguages, resolveLanguagePreference } from '@/i18n/language'
import { syncNativeUiLanguage } from '@/lib/native-ui-api'
import { useAppSettingsLoaded, useUiLanguage } from '@/stores/app-settings-store'

export function useAppliedLanguageSync(): void {
  const isLoaded = useAppSettingsLoaded()
  const preference = useUiLanguage()

  useEffect(() => {
    if (!isLoaded) return

    const applyPreference = (): void => {
      const language = resolveLanguagePreference(preference, getBrowserLanguages())
      void changeUiLanguage(language).then(() => syncNativeUiLanguage(language))
    }

    applyPreference()

    if (preference !== 'system') return

    window.addEventListener('languagechange', applyPreference)
    return () => window.removeEventListener('languagechange', applyPreference)
  }, [isLoaded, preference])
}
