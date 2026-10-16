import { PersistenceKeys } from '@shared/types/persistence.types'
import { useCallback, useEffect } from 'react'
import { persistenceApi } from '@/lib/api'
import { useSharedKeySync } from '@/lib/shared-key-sync'
import { useContextBarSettingsStore } from '@/stores/context-bar-settings-store'
import type { ContextBarSettings } from '@/types/settings'
import { DEFAULT_CONTEXT_BAR_SETTINGS } from '@/types/settings'

// Merge with defaults to handle any new settings added in future versions.
// A saved blob predating `showProjectName` keeps today's always-on project
// name; blobs written since carry the key and win.
function mergeWithDefaults(saved: Partial<ContextBarSettings>): ContextBarSettings {
  return { ...DEFAULT_CONTEXT_BAR_SETTINGS, showProjectName: true, ...saved }
}

/**
 * Hook to load and persist context bar settings
 * Loads settings from persistence on mount and applies to store
 */
export function useContextBarSettings(): void {
  const setSettings = useContextBarSettingsStore((state) => state.setSettings)
  const setLoaded = useContextBarSettingsStore((state) => state.setLoaded)

  // A change another device or tab saved: show it without a reload.
  useSharedKeySync<Partial<ContextBarSettings>>(PersistenceKeys.contextBarSettings, (change) => {
    if (change.exists && change.data) setSettings(mergeWithDefaults(change.data))
  })

  useEffect(() => {
    async function loadSettings(): Promise<void> {
      try {
        const result = await persistenceApi.read<Partial<ContextBarSettings>>(
          PersistenceKeys.contextBarSettings
        )

        if (result.success && result.data) {
          setSettings(mergeWithDefaults(result.data))
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

export function useUpdateContextBarSetting(): (element: keyof ContextBarSettings) => Promise<void> {
  const toggleElement = useContextBarSettingsStore((state) => state.toggleElement)

  return useCallback(
    async (element: keyof ContextBarSettings) => {
      toggleElement(element)
      const updatedSettings = useContextBarSettingsStore.getState().settings
      await persistenceApi.writeDebounced(PersistenceKeys.contextBarSettings, updatedSettings)
    },
    [toggleElement]
  )
}
