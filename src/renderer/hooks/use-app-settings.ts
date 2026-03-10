import { useEffect, useCallback } from 'react'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useSidebarStore } from '@/stores/sidebar-store'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { persistenceApi, terminalApi } from '@/lib/api'
import type { AppSettings } from '@/types/settings'
import { DEFAULT_APP_SETTINGS, APP_SETTINGS_KEY } from '@/types/settings'

type PanelSettingKey = 'sidebarVisible' | 'fileExplorerVisible'

type PanelWriteRequest = {
  panel: PanelSettingKey
  visible: boolean
  requestId: number
  revision: number
}

let panelWriteChain: Promise<void> = Promise.resolve()
const panelWriteRequestIds: Record<PanelSettingKey, number> = {
  sidebarVisible: 0,
  fileExplorerVisible: 0
}
let panelWriteRevision = 0
let lastSuccessfulPanelWriteRevision = 0
let persistedPanelSettingsSnapshot: AppSettings = { ...DEFAULT_APP_SETTINGS }
let pendingPanelWriteCount = 0
let pendingPanelWriteWaiters: Array<() => void> = []

function notifyPanelWriteSettled(): void {
  if (pendingPanelWriteCount === 0 && pendingPanelWriteWaiters.length > 0) {
    const waiters = pendingPanelWriteWaiters
    pendingPanelWriteWaiters = []
    waiters.forEach((resolve) => {
      resolve()
    })
  }
}

function syncPersistedPanelSettingsSnapshot(settings: AppSettings): void {
  persistedPanelSettingsSnapshot = { ...settings }
}

function buildPanelWriteSnapshot(request: PanelWriteRequest): AppSettings {
  const currentSettings = useAppSettingsStore.getState().settings

  return {
    ...currentSettings,
    sidebarVisible: persistedPanelSettingsSnapshot.sidebarVisible,
    fileExplorerVisible: persistedPanelSettingsSnapshot.fileExplorerVisible,
    [request.panel]: request.visible
  }
}

function enqueuePanelWrite(request: PanelWriteRequest): Promise<void> {
  pendingPanelWriteCount += 1
  const run = panelWriteChain.then(async () => {
    const settingsSnapshot = buildPanelWriteSnapshot(request)
    const result = await persistenceApi.write(APP_SETTINGS_KEY, settingsSnapshot)

    if (!result.success) {
      const isLatestPanelRequest = panelWriteRequestIds[request.panel] === request.requestId
      const canRollbackToLastPersistedValue = request.revision > lastSuccessfulPanelWriteRevision

      if (isLatestPanelRequest && canRollbackToLastPersistedValue) {
        const rollbackValue = persistedPanelSettingsSnapshot[request.panel]
        useAppSettingsStore.getState().updateSetting(request.panel, rollbackValue)
        applyPanelVisibilityToUi(request.panel, rollbackValue)
      }

      throw new Error(result.error || `Failed to persist ${request.panel}`)
    }

    syncPersistedPanelSettingsSnapshot(settingsSnapshot)
    lastSuccessfulPanelWriteRevision = request.revision
  })
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
  panelWriteRevision = 0
  lastSuccessfulPanelWriteRevision = 0
  persistedPanelSettingsSnapshot = { ...DEFAULT_APP_SETTINGS }
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

      syncPersistedPanelSettingsSnapshot(settings)

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
      const request: PanelWriteRequest = {
        panel,
        visible,
        requestId,
        revision: ++panelWriteRevision
      }

      updateSetting(panel, visible)
      applyPanelVisibilityToUi(panel, visible)

      return enqueuePanelWrite(request)
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

    const result = await persistenceApi.write(APP_SETTINGS_KEY, DEFAULT_APP_SETTINGS)
    if (result.success) {
      syncPersistedPanelSettingsSnapshot(DEFAULT_APP_SETTINGS)
    }
  }, [resetToDefaults])
}
