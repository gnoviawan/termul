import { useEffect } from 'react'
import { persistenceApi } from '@/lib/api'
import type { TocSettings } from '@/types/settings'
import { DEFAULT_TOC_SETTINGS, TOC_SETTINGS_KEY } from '@/types/settings'
import { useTocSettingsStore } from '@/stores/toc-settings-store'

let loadPromise: Promise<void> | null = null
let hasSubscribedToPersistence = false

async function initializeTocSettings(
  setSettings: (settings: TocSettings) => void,
  setLoaded: (loaded: boolean) => void,
  setLoadFailed: (failed: boolean) => void
): Promise<void> {
  try {
    const result = await persistenceApi.read<TocSettings>(TOC_SETTINGS_KEY)

    if (result.success && result.data) {
      setSettings({
        ...DEFAULT_TOC_SETTINGS,
        ...result.data
      })
      setLoadFailed(false)
      setLoaded(true)
      return
    }

    if (!result.success && result.code === 'KEY_NOT_FOUND') {
      setSettings(DEFAULT_TOC_SETTINGS)
      setLoadFailed(false)
      setLoaded(true)
      return
    }

    setLoadFailed(true)
    console.error('Failed to load TOC settings')
  } catch {
    setLoadFailed(true)
    console.error('Failed to load TOC settings')
  }
}

export function useTocSettings(): void {
  const setSettings = useTocSettingsStore((state) => state.setSettings)
  const setLoaded = useTocSettingsStore((state) => state.setLoaded)
  const setLoadFailed = useTocSettingsStore((state) => state.setLoadFailed)

  useEffect(() => {
    if (!hasSubscribedToPersistence) {
      useTocSettingsStore.subscribe((state) => {
        if (!state.isLoaded || state.loadFailed) {
          return
        }

        void persistenceApi.writeDebounced(TOC_SETTINGS_KEY, state.settings)
      })

      hasSubscribedToPersistence = true
    }

    const storeState = useTocSettingsStore.getState()
    if (!loadPromise && !storeState.isLoaded && !storeState.loadFailed) {
      loadPromise = initializeTocSettings(setSettings, setLoaded, setLoadFailed)
    }
  }, [setLoadFailed, setLoaded, setSettings])
}
