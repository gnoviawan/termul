import { useCallback, useEffect } from 'react'
import { acpApi, persistenceApi, terminalApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { getSystemAppearance, normalizeThemeFamilyId } from '@/lib/themes/theme-appearance'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useSidebarStore } from '@/stores/sidebar-store'
import { useSSHPanelStore } from '@/stores/ssh-panel-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { AppPanelVisibilitySettingKey, AppSettings, AppSettingsUpdate } from '@/types/settings'
import { APP_SETTINGS_KEY, DEFAULT_APP_SETTINGS } from '@/types/settings'

type PanelSettingKey = AppPanelVisibilitySettingKey

type PanelWriteRequest = {
  panel: PanelSettingKey
  visible: boolean
  requestId: number
  revision: number
}

let panelWriteChain: Promise<void> = Promise.resolve()
const panelWriteRequestIds: Record<PanelSettingKey, number> = {
  sidebarVisible: 0,
  fileExplorerVisible: 0,
  sshPanelVisible: 0
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
    sshPanelVisible: persistedPanelSettingsSnapshot.sshPanelVisible,
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
  panelWriteRequestIds.sshPanelVisible = 0
  panelWriteRevision = 0
  lastSuccessfulPanelWriteRevision = 0
  persistedPanelSettingsSnapshot = { ...DEFAULT_APP_SETTINGS }
  pendingPanelWriteCount = 0
  pendingPanelWriteWaiters = []
  disposeOrphanDetectionRetryForTests()
}

/** @internal Test-only: disarm the one-shot post-attach retry. */
export function disposeOrphanDetectionRetryForTests(): void {
  orphanDetectionRetryArmed = false
  orphanDetectionRetryUnsubscribe?.()
  orphanDetectionRetryUnsubscribe = undefined
}

function applyPanelVisibilityToUi(panel: PanelSettingKey, visible: boolean): void {
  if (panel === 'sidebarVisible') {
    useSidebarStore.getState().setVisible(visible)
    return
  }

  if (panel === 'sshPanelVisible') {
    useSSHPanelStore.getState().setVisible(visible)
    return
  }

  useFileExplorerStore.getState().setVisible(visible)
}

/** Whether the one-shot post-attach orphan-detection retry is armed. */
let orphanDetectionRetryArmed = false
/** Test-reset hook for the retry's store subscription. */
let orphanDetectionRetryUnsubscribe: (() => void) | undefined

/**
 * QA round 2 / spec story 5: retry the orphan-detection settings push ONCE
 * after the first terminal of the session attaches. The immediate push in
 * `useAppSettingsLoader` now succeeds whenever the terminal channel is
 * authenticated; the residual failure mode is the push landing while the
 * connection is still un-authed (server answers the single generic
 * UNAUTHORIZED). Once a terminal has a ptyId the connection that spawned or
 * attached it is necessarily authenticated, so the retry then succeeds.
 * One-shot: success or failure both disarm (boundary logged; no retries
 * storming the settings surface). Desktop is unaffected — the Tauri
 * transport's updateOrphanDetection never fails with UNAUTHORIZED.
 */
function scheduleOrphanDetectionRetryAfterFirstAttach(settings: AppSettings): void {
  if (orphanDetectionRetryArmed) return
  orphanDetectionRetryArmed = true

  const retry = (attempt: number): void => {
    const store = useTerminalStore.getState()
    const hasAttachedTerminal = store.terminals.some((terminal) => !!terminal.ptyId)
    if (!hasAttachedTerminal) {
      // No terminal attached yet — keep watching (bounded by unsubscribe on
      // unmount; the store subscription below re-drives the check).
      return
    }
    unsubscribe()
    void terminalApi
      .updateOrphanDetection(settings.orphanDetectionEnabled, settings.orphanDetectionTimeout)
      .then((result) => {
        if (result.success) {
          void logFrontendError({
            level: 'warn',
            source: 'use-app-settings.orphanDetectionRetry',
            message: 'orphan detection settings applied on post-attach retry'
          })
        } else {
          void logFrontendError({
            level: 'warn',
            source: 'use-app-settings.orphanDetectionRetry',
            message: `post-attach orphan detection retry failed (${result.code ?? 'UNKNOWN'}) — settings not applied`
          })
        }
      })
      .catch(() => {
        void logFrontendError({
          level: 'warn',
          source: 'use-app-settings.orphanDetectionRetry',
          message: `post-attach orphan detection retry failed (attempt ${attempt}) — settings not applied`
        })
      })
  }

  const unsubscribe = useTerminalStore.subscribe(() => retry(1))
  orphanDetectionRetryUnsubscribe = unsubscribe

  // The store may already have an attached terminal at arm time.
  retry(0)
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
        let shouldPersistSettings = false
        const rawAppearance = result.data.appearanceMode as string | undefined
        const hasLegacyLightThemeId = settings.colorTheme.endsWith('-light')

        if (hasLegacyLightThemeId) {
          settings = {
            ...settings,
            colorTheme: normalizeThemeFamilyId(settings.colorTheme),
            appearanceMode: settings.appearanceMode ?? 'light'
          }
          shouldPersistSettings = true
        }

        if (rawAppearance === undefined && !hasLegacyLightThemeId) {
          settings = { ...settings, appearanceMode: 'dark' }
          shouldPersistSettings = true
        }

        if (rawAppearance === 'system') {
          settings = { ...settings, appearanceMode: getSystemAppearance() }
          shouldPersistSettings = true
        } else if (settings.appearanceMode !== 'light' && settings.appearanceMode !== 'dark') {
          settings = { ...settings, appearanceMode: 'dark' }
          shouldPersistSettings = true
        }

        // Migrate persisted "canvas" renderer preference to "dom"
        // xterm 6.0 removed @xterm/addon-canvas; DOM is now the built-in fallback
        if ((settings as unknown as Record<string, unknown>).terminalRenderer === 'canvas') {
          settings = { ...settings, terminalRenderer: 'dom' as const }
          shouldPersistSettings = true
        }

        setSettings(settings)
        if (shouldPersistSettings) {
          void persistenceApi.writeDebounced(APP_SETTINGS_KEY, settings)
        }
      } else {
        settings = DEFAULT_APP_SETTINGS
        setSettings(settings)
      }

      syncPersistedPanelSettingsSnapshot(settings)

      useSidebarStore.getState().setVisible(settings.sidebarVisible)
      useFileExplorerStore.getState().setVisible(settings.fileExplorerVisible)
      useSSHPanelStore.getState().setVisible(settings.sshPanelVisible)

      // Apply orphan detection settings to PtyManager after settings load.
      // QA round 2 / spec story 5: the server now ACCEPTS this push on any
      // authed connection (even with zero terminals attached), so the
      // immediate push succeeds on web boot. The deferral below is the
      // robustness net for the case the push races the auth handshake
      // (UNAUTHORIZED): retry ONCE after the first terminal attach — by then
      // the connection is authenticated and the op is admissible. If no
      // terminal ever attaches, no retry fires (harmless — nothing to
      // configure the lifecycle of).
      try {
        const orphanResult = await terminalApi.updateOrphanDetection(
          settings.orphanDetectionEnabled,
          settings.orphanDetectionTimeout
        )
        if (!orphanResult.success && orphanResult.code === 'UNAUTHORIZED') {
          scheduleOrphanDetectionRetryAfterFirstAttach(settings)
        }
      } catch (error) {
        console.error('Failed to apply orphan detection settings:', error)
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
      await persistenceApi.writeDebounced(APP_SETTINGS_KEY, updatedSettings)
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
      await persistenceApi.writeDebounced(APP_SETTINGS_KEY, updatedSettings)
    },
    [updateSettings]
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
    useSSHPanelStore.getState().setVisible(DEFAULT_APP_SETTINGS.sshPanelVisible)

    const result = await persistenceApi.write(APP_SETTINGS_KEY, DEFAULT_APP_SETTINGS)
    if (result.success) {
      syncPersistedPanelSettingsSnapshot(DEFAULT_APP_SETTINGS)
    }
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
