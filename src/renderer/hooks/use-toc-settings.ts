import { PersistenceKeys } from '@shared/types/persistence.types'
import { useEffect } from 'react'
import { persistenceApi } from '@/lib/api'
import { useSharedKeySync } from '@/lib/shared-key-sync'
import { useTocSettingsStore } from '@/stores/toc-settings-store'
import type { TocSettings } from '@/types/settings'
import { DEFAULT_TOC_SETTINGS } from '@/types/settings'

let loadPromise: Promise<void> | null = null
let hasSubscribedToPersistence = false
/** True while a change from another device is applied: it must not be saved again. */
let applyingRemoteChange = false

async function initializeTocSettings(
  setSettings: (settings: TocSettings) => void,
  setLoaded: (loaded: boolean) => void,
  setLoadFailed: (failed: boolean) => void
): Promise<void> {
  try {
    const result = await persistenceApi.read<TocSettings>(PersistenceKeys.tocSettings)

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

  // A change another device or tab saved: show it without a reload.
  useSharedKeySync<TocSettings>(PersistenceKeys.tocSettings, (change) => {
    if (!change.exists || !change.data) return
    applyingRemoteChange = true
    try {
      setSettings({ ...DEFAULT_TOC_SETTINGS, ...change.data })
    } finally {
      applyingRemoteChange = false
    }
  })

  useEffect(() => {
    if (!hasSubscribedToPersistence) {
      useTocSettingsStore.subscribe((state) => {
        if (!state.isLoaded || state.loadFailed || applyingRemoteChange) {
          return
        }

        void persistenceApi.writeDebounced(PersistenceKeys.tocSettings, state.settings)
      })

      hasSubscribedToPersistence = true
    }

    const storeState = useTocSettingsStore.getState()
    if (!loadPromise && !storeState.isLoaded && !storeState.loadFailed) {
      loadPromise = initializeTocSettings(setSettings, setLoaded, setLoadFailed)
    }
  }, [setLoadFailed, setLoaded, setSettings])
}
