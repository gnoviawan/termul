import { useCallback, useEffect } from 'react'
import { useContextBarSettingsStore } from '@/stores/context-bar-settings-store'
import { persistenceApi } from '@/lib/api'
import { CONTEXT_BAR_SETTINGS_KEY, DEFAULT_CONTEXT_BAR_SETTINGS } from '@/types/settings'
import type { ContextBarSettings } from '@/types/settings'

/**
 * Hook to load and persist context bar settings
 * Loads settings from persistence on mount and applies to store
 */
export function useContextBarSettings(): void {
  const setSettings = useContextBarSettingsStore((state) => state.setSettings)
  const setLoaded = useContextBarSettingsStore((state) => state.setLoaded)

  useEffect(() => {
    async function loadSettings(): Promise<void> {
      try {
        const result = await persistenceApi.read<ContextBarSettings>(
          CONTEXT_BAR_SETTINGS_KEY
        )

        if (result.success && result.data) {
          // Merge with defaults to handle any new settings added in future versions
          const mergedSettings: ContextBarSettings = {
            ...DEFAULT_CONTEXT_BAR_SETTINGS,
            ...result.data
          }
          setSettings(mergedSettings)
        }
        // If no settings exist yet, defaults are already in store
      } catch {
        // On error, keep defaults
        console.error('Failed to load context bar settings')
      } finally {
        setLoaded(true)
      }
    }

    loadSettings()
  }, [setSettings, setLoaded])
}

export function useUpdateContextBarSetting(): (
  element: keyof ContextBarSettings
) => Promise<void> {
  const toggleElement = useContextBarSettingsStore((state) => state.toggleElement)

  return useCallback(
    async (element: keyof ContextBarSettings) => {
      toggleElement(element)
      const updatedSettings = useContextBarSettingsStore.getState().settings
      await persistenceApi.writeDebounced(CONTEXT_BAR_SETTINGS_KEY, updatedSettings)
    },
    [toggleElement]
  )
}
