import { PersistenceKeys } from '@shared/types/persistence.types'
import { useCallback, useEffect } from 'react'
import { acpApi, persistenceApi } from '@/lib/api'
import { useSharedKeySync } from '@/lib/shared-key-sync'
import { getSystemAppearance, normalizeThemeFamilyId } from '@/lib/themes/theme-appearance'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useShellLayoutStore } from '@/stores/shell-layout-store'
import { setSidebarVisible } from '@/stores/sidebar-store'
import { setSSHPanelVisible } from '@/stores/ssh-panel-store'
import type { AppSettings, AppSettingsUpdate } from '@/types/settings'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'

type PanelSettingKey = 'sidebarVisible' | 'fileExplorerVisible' | 'sshPanelVisible'

function applyPanelVisibility(panel: PanelSettingKey, visible: boolean): void {
  if (panel === 'sidebarVisible') {
    setSidebarVisible(visible)
  } else if (panel === 'sshPanelVisible') {
    setSSHPanelVisible(visible)
  } else {
    useShellLayoutStore.getState().setSidePanelVisible(visible)
  }
}

/** Settings an older version persisted that no longer have any effect. */
const RETIRED_SETTING_KEYS = [
  'maxTerminalsPerProject',
  'orphanDetectionEnabled',
  'orphanDetectionTimeout'
] as const

/**
 * Fills a stored settings record in from the defaults and drops or rewrites
 * what an older version wrote. `changed` tells that the stored record differs
 * from the result.
 */
function normalizeStoredSettings(data: AppSettings): { settings: AppSettings; changed: boolean } {
  // Merge with defaults to handle any missing keys from older versions
  let settings: AppSettings = { ...DEFAULT_APP_SETTINGS, ...data }
  let changed = false

  // The per-project terminal limit moved to the host, and a live PTY no
  // longer expires by inactivity. Drop the retired keys an older version
  // persisted so they are not carried forward.
  const retiredKeys = RETIRED_SETTING_KEYS.filter((key) => key in settings)
  if (retiredKeys.length > 0) {
    const current: Record<string, unknown> = { ...settings }
    for (const key of retiredKeys) delete current[key]
    settings = current as unknown as AppSettings
    changed = true
  }

  const rawAppearance = data.appearanceMode as string | undefined
  const hasLegacyLightThemeId = settings.colorTheme.endsWith('-light')

  if (hasLegacyLightThemeId) {
    settings = {
      ...settings,
      colorTheme: normalizeThemeFamilyId(settings.colorTheme),
      appearanceMode: settings.appearanceMode ?? 'light'
    }
    changed = true
  }

  if (rawAppearance === undefined && !hasLegacyLightThemeId) {
    settings = { ...settings, appearanceMode: 'dark' }
    changed = true
  }

  if (rawAppearance === 'system') {
    settings = { ...settings, appearanceMode: getSystemAppearance() }
    changed = true
  } else if (settings.appearanceMode !== 'light' && settings.appearanceMode !== 'dark') {
    settings = { ...settings, appearanceMode: 'dark' }
    changed = true
  }

  // Migrate persisted "canvas" renderer preference to "dom"
  // xterm 6.0 removed @xterm/addon-canvas; DOM is now the built-in fallback
  if ((settings as unknown as Record<string, unknown>).terminalRenderer === 'canvas') {
    settings = { ...settings, terminalRenderer: 'dom' as const }
    changed = true
  }
  return { settings, changed }
}

export function useAppSettingsLoader(): void {
  const setSettings = useAppSettingsStore((state) => state.setSettings)

  // A change another device or tab saved: show it without a reload.
  useSharedKeySync<AppSettings>(PersistenceKeys.appSettings, (change) => {
    if (change.exists && change.data) setSettings(normalizeStoredSettings(change.data).settings)
  })

  useEffect(() => {
    async function load(): Promise<void> {
      const result = await persistenceApi.read<AppSettings>(PersistenceKeys.appSettings)
      let settings: AppSettings

      if (result.success && result.data) {
        const normalized = normalizeStoredSettings(result.data)
        settings = normalized.settings
        setSettings(settings)
        if (normalized.changed) {
          void persistenceApi.writeDebounced(PersistenceKeys.appSettings, settings)
        }
      } else {
        settings = DEFAULT_APP_SETTINGS
        setSettings(settings)
      }

      // Push the ACP timeout overrides to the Rust core (desktop-only via the
      // transport; the WS transport no-ops on the standalone server, which
      // configures via the TERMUL_ACP_* env vars).
      try {
        await acpApi.setTurnTimeout(settings.acpTurnTimeoutSecs)
      } catch (error) {
        console.error('Failed to apply ACP turn timeout:', error)
      }
      try {
        await acpApi.setTurnIdleTimeout(settings.acpTurnIdleTimeoutSecs)
      } catch (error) {
        console.error('Failed to apply ACP turn idle timeout:', error)
      }
      try {
        await acpApi.setSessionNewTimeout(settings.acpSessionNewTimeoutSecs)
      } catch (error) {
        console.error('Failed to apply ACP session/new timeout:', error)
      }
      try {
        await acpApi.setSessionReopenTimeout(settings.acpSessionReopenTimeoutSecs)
      } catch (error) {
        console.error('Failed to apply ACP session reopen timeout:', error)
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
      await persistenceApi.writeDebounced(PersistenceKeys.appSettings, updatedSettings)
    },
    [updateSetting]
  )
}

export function useUpdateAppSettings(): (updates: AppSettingsUpdate) => Promise<void> {
  const updateSettings = useAppSettingsStore((state) => state.updateSettings)

  return useCallback(
    async (updates: AppSettingsUpdate) => {
      updateSettings(updates)
      const updatedSettings = useAppSettingsStore.getState().settings
      await persistenceApi.writeDebounced(PersistenceKeys.appSettings, updatedSettings)
    },
    [updateSettings]
  )
}

/**
 * Panel visibility lives in the shell-layout store (single owner); this hook
 * only dispatches to its actions, which keep their own hydration gate and
 * persistence. It never reads or writes `AppSettings`.
 */
export function useUpdatePanelVisibility(): (
  panel: PanelSettingKey,
  visible: boolean
) => Promise<void> {
  return useCallback(async (panel: PanelSettingKey, visible: boolean) => {
    applyPanelVisibility(panel, visible)
  }, [])
}

export function useResetAppSettings(): () => Promise<void> {
  const resetToDefaults = useAppSettingsStore((state) => state.resetToDefaults)

  return useCallback(async () => {
    resetToDefaults()
    // Reset reopens all three panels, through the shell-layout actions.
    applyPanelVisibility('sidebarVisible', true)
    applyPanelVisibility('fileExplorerVisible', true)
    applyPanelVisibility('sshPanelVisible', true)

    await persistenceApi.write(PersistenceKeys.appSettings, DEFAULT_APP_SETTINGS)
    // Clear the in-process ACP timeout overrides too (mirrors the load
    // hook's push, so a reset doesn't leave stale overrides in the Rust core).
    try {
      await acpApi.setTurnTimeout(DEFAULT_APP_SETTINGS.acpTurnTimeoutSecs)
    } catch (error) {
      console.error('Failed to clear ACP turn timeout on reset:', error)
    }
    try {
      await acpApi.setTurnIdleTimeout(DEFAULT_APP_SETTINGS.acpTurnIdleTimeoutSecs)
    } catch (error) {
      console.error('Failed to clear ACP turn idle timeout on reset:', error)
    }
    try {
      await acpApi.setSessionNewTimeout(DEFAULT_APP_SETTINGS.acpSessionNewTimeoutSecs)
    } catch (error) {
      console.error('Failed to clear ACP session/new timeout on reset:', error)
    }
    try {
      await acpApi.setSessionReopenTimeout(DEFAULT_APP_SETTINGS.acpSessionReopenTimeoutSecs)
    } catch (error) {
      console.error('Failed to clear ACP session reopen timeout on reset:', error)
    }
  }, [resetToDefaults])
}
