import { useEffect } from 'react'
import { persistenceApi } from '@/lib/api'
import type { TocSettings } from '@/types/settings'
import { DEFAULT_TOC_SETTINGS, TOC_SETTINGS_KEY } from '@/types/settings'
import { useTocSettingsStore } from '@/stores/toc-settings-store'

let loadPromise: Promise<void> | null = null
let hasSubscribedToPersistence = false

async function initializeTocSettings(
  setSettings: (settings: TocSettings) => void,
  setLoaded: (loaded: boolean) => void
): Promise<void> {
  try {
    const result = await persistenceApi.read<TocSettings>(TOC_SETTINGS_KEY)

    if (result.success && result.data) {
      setSettings({
        ...DEFAULT_TOC_SETTINGS,
        ...result.data
      })
    }
  } catch {
    console.error('Failed to load TOC settings')
  } finally {
    setLoaded(true)
  }
}

export function useTocSettings(): void {
  const setSettings = useTocSettingsStore((state) => state.setSettings)
  const setLoaded = useTocSettingsStore((state) => state.setLoaded)

  useEffect(() => {
    if (!hasSubscribedToPersistence) {
      useTocSettingsStore.subscribe((state) => {
        if (!state.isLoaded) {
          return
        }

        void persistenceApi.writeDebounced(TOC_SETTINGS_KEY, state.settings)
      })

      hasSubscribedToPersistence = true
    }

    if (!loadPromise && !useTocSettingsStore.getState().isLoaded) {
      loadPromise = initializeTocSettings(setSettings, setLoaded)
    }
  }, [setLoaded, setSettings])
}
