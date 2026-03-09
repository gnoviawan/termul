import { useEffect, useCallback } from 'react'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useSidebarStore } from '@/stores/sidebar-store'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { persistenceApi, terminalApi } from '@/lib/api'
import type { AppSettings } from '@/types/settings'
import { DEFAULT_APP_SETTINGS, APP_SETTINGS_KEY } from '@/types/settings'

type PanelSettingKey = 'sidebarVisible' | 'fileExplorerVisible'

let panelWriteChain: Promise<void> = Promise.resolve()
const panelWriteRequestIds: Record<PanelSettingKey, number> = {
  sidebarVisible: 0,
  fileExplorerVisible: 0
}
let pendingPanelWriteCount = 0
let pendingPanelWriteWaiters: Array<() => void> = []

function notifyPanelWriteSettled(): void {
  if (pendingPanelWriteCount === 0 && pendingPanelWriteWaiters.length > 0) {
    const waiters = pendingPanelWriteWaiters
    pendingPanelWriteWaiters = []
    waiters.forEach((resolve) => resolve())
  }
}

function enqueuePanelWrite(task: () => Promise<void>): Promise<void> {
  pendingPanelWriteCount += 1
  const run = panelWriteChain.then(task)
  panelWriteChain = run.catch(() => undefined)

  return run.finally(() => {
    pendingPanelWriteCount = Math.max(0, pendingPanelWriteCount - 1)
    notifyPanelWriteSettled()
  })
}

export async function waitForPendingAppSettingsPersistence(): Promise<void> {
  await panelWriteChain.catch(() => undefined)

  if (pendingPanelWriteCount === 0) {
    return
  }

  await new Promise<void>((resolve) => {
    pendingPanelWriteWaiters.push(resolve)
  })
}

export function resetAppSettingsPersistenceQueueForTests(): void {
  panelWriteChain = Promise.resolve()
  panelWriteRequestIds.sidebarVisible = 0
  panelWriteRequestIds.fileExplorerVisible = 0
  pendingPanelWriteCount = 0
  pendingPanelWriteWaiters = []
}

function applyPanelVisibilityToUi(panel: PanelSettingKey, visible: boolean): void {
  if (panel === 'sidebarVisible') {
    useSidebarStore.getState().setVisible(visible)
    return
  }

  useFileExplorerStore.getState().setVisible(visible)
}

function getPanelVisibility(panel: PanelSettingKey): boolean {
  if (panel === 'sidebarVisible') {
    return useSidebarStore.getState().isVisible
  }

  return useFileExplorerStore.getState().isVisible
}

export function useAppSettingsLoader(): void {
  const setSettings = useAppSettingsStore((state) => state.setSettings)

  useEffect(() => {
    async function load(): Promise<void> {
      const result = await persistenceApi.read<AppSettings>(APP_SETTINGS_KEY)
      let settings: AppSettings

      if (result.success && result.data) {
        // Merge with defaults to handle any missing keys from older versions
        settings = { ...DEFAULT_APP_SETTINGS, ...result.data }
        setSettings(settings)
      } else {
        settings = DEFAULT_APP_SETTINGS
        setSettings(settings)
      }

      useSidebarStore.getState().setVisible(settings.sidebarVisible)
      useFileExplorerStore.getState().setVisible(settings.fileExplorerVisible)

      // Apply orphan detection settings to PtyManager after settings load
      try {
        await terminalApi.updateOrphanDetection(
          settings.orphanDetectionEnabled,
          settings.orphanDetectionTimeout
        )
      } catch (error) {
        console.error('Failed to apply orphan detection settings:', error)
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
      await persistenceApi.writeDebounced(APP_SETTINGS_KEY, updatedSettings)
    },
    [updateSetting]
  )
}

export function useUpdatePanelVisibility(): (
  panel: PanelSettingKey,
  visible: boolean
) => Promise<void> {
  const updateSetting = useAppSettingsStore((state) => state.updateSetting)

  return useCallback(
    async (panel: PanelSettingKey, visible: boolean) => {
      const requestId = ++panelWriteRequestIds[panel]
      const previousValue = getPanelVisibility(panel)

      updateSetting(panel, visible)
      applyPanelVisibilityToUi(panel, visible)

      return enqueuePanelWrite(async () => {
        const settingsSnapshot = useAppSettingsStore.getState().settings
        const result = await persistenceApi.write(APP_SETTINGS_KEY, settingsSnapshot)

        if (!result.success) {
          // Revert only if no newer panel write request has superseded this one.
          if (panelWriteRequestIds[panel] === requestId) {
            updateSetting(panel, previousValue)
            applyPanelVisibilityToUi(panel, previousValue)
          }
          throw new Error(result.error || `Failed to persist ${panel}`)
        }
      })
    },
    [updateSetting]
  )
}

export function useResetAppSettings(): () => Promise<void> {
  const resetToDefaults = useAppSettingsStore((state) => state.resetToDefaults)

  return useCallback(async () => {
    resetToDefaults()
    useSidebarStore.getState().setVisible(DEFAULT_APP_SETTINGS.sidebarVisible)
    useFileExplorerStore.getState().setVisible(DEFAULT_APP_SETTINGS.fileExplorerVisible)
    await persistenceApi.write(APP_SETTINGS_KEY, DEFAULT_APP_SETTINGS)
  }, [resetToDefaults])
}
