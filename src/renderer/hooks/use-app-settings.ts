import { useEffect, useCallback } from 'react'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import type { AppSettings } from '@/types/settings'
import { DEFAULT_APP_SETTINGS, APP_SETTINGS_KEY } from '@/types/settings'

export function useAppSettingsLoader(): void {
  const setSettings = useAppSettingsStore((state) => state.setSettings)

  useEffect(() => {
    async function load(): Promise<void> {
      const result = await window.api.persistence.read<AppSettings>(APP_SETTINGS_KEY)
      if (result.success && result.data) {
        // Merge with defaults to handle any missing keys from older versions
        setSettings({ ...DEFAULT_APP_SETTINGS, ...result.data })
      } else {
        setSettings(DEFAULT_APP_SETTINGS)
      }
    }
    load()
  }, [setSettings])
}

export function useUpdateAppSetting<K extends keyof AppSettings>(): (
  key: K,
  value: AppSettings[K]
) => Promise<void> {
  const updateSetting = useAppSettingsStore((state) => state.updateSetting)

  return useCallback(
    async (key: K, value: AppSettings[K]) => {
      updateSetting(key, value)
      // Use callback to get the latest state after update
      // Note: Zustand updates are synchronous, so getState() after updateSetting() returns updated state
      const updatedSettings = useAppSettingsStore.getState().settings
      await window.api.persistence.writeDebounced(APP_SETTINGS_KEY, updatedSettings)
    },
    [updateSetting]
  )
}

export function useResetAppSettings(): () => Promise<void> {
  const resetToDefaults = useAppSettingsStore((state) => state.resetToDefaults)

  return useCallback(async () => {
    resetToDefaults()
    await window.api.persistence.write(APP_SETTINGS_KEY, DEFAULT_APP_SETTINGS)
  }, [resetToDefaults])
}
