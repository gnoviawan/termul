import type { DetectedShells } from '@shared/types/ipc.types'
import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { SettingsLayout } from '@/components/settings/SettingsLayout'
import { SettingsModal } from '@/components/settings/SettingsModal'
import {
  queueAgentIdleWindowPush,
  useResetAppSettings,
  useUpdateAppSetting
} from '@/hooks/use-app-settings'
import {
  useResetAllShortcuts,
  useResetShortcut,
  useUpdateShortcut
} from '@/hooks/use-keyboard-shortcuts'
import { acpApi, shellApi } from '@/lib/api'
import { scheduleAllDirtyAutoSaves } from '@/lib/editor-auto-save'
import { logFrontendError } from '@/lib/log-api'
import { isAurUpdateMode } from '@/lib/tauri-updater-api'
import {
  useAcpSessionNewTimeout,
  useAcpSessionReopenTimeout,
  useAcpTurnIdleTimeout,
  useAcpTurnTimeout,
  useAgentIdleWindow,
  useConfirmTerminalClose,
  useDefaultProjectColor,
  useDefaultShell,
  useEditorAutoSave,
  useEditorAutoSaveDelayMs,
  useNotifyOnAgentChatNeedsYou,
  useNotifyOnAgentChatTurnFinished,
  useNotifyOnTerminalIdle,
  useTerminalBufferSize,
  useTerminalFontFamily,
  useTerminalFontSize,
  useTerminalRenderer,
  useTerminalScreenReaderMode,
  useTerminalUrlOpenMode,
  useUiZoomLevel
} from '@/stores/app-settings-store'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { useUpdaterActions, useUpdaterState } from '@/stores/updater-store'
import type { ProjectColor } from '@/types/project'
import {
  TERMINAL_URL_OPEN_MODE_OPTIONS,
  type TerminalUrlOpenMode,
  UI_ZOOM_DEFAULT
} from '@/types/settings'
import { AiAgentsSection } from './app-preferences/ai-agents-section'
import { AppearanceSection } from './app-preferences/appearance-section'
import { BehaviorSection } from './app-preferences/behavior-section'
import { APP_PREF_CATEGORIES, APP_PREF_SEARCH_INDEX } from './app-preferences/categories'
import { DiagnosticsSection } from './app-preferences/diagnostics-section'
import { McpServersSection } from './app-preferences/mcp-servers-section'
import { ProjectDefaultsSection } from './app-preferences/project-defaults-section'
import { ProviderSection } from './app-preferences/provider-section'
import { ResetSection } from './app-preferences/reset-section'
import { ShellSection } from './app-preferences/shell-section'
import { ShortcutsSection } from './app-preferences/shortcuts-section'
import { UpdatesSection } from './app-preferences/updates-section'

export function AppPreferencesModal(): React.JSX.Element {
  const isOpen = useSettingsModalStore((state) => state.view === 'app')
  const close = useSettingsModalStore((state) => state.close)
  const isAurUpdater = isAurUpdateMode()
  const fontFamily = useTerminalFontFamily()
  const fontSize = useTerminalFontSize()
  const uiZoomLevel = useUiZoomLevel()
  const bufferSize = useTerminalBufferSize()
  const terminalRenderer = useTerminalRenderer()
  const terminalScreenReaderMode = useTerminalScreenReaderMode()
  const defaultShell = useDefaultShell()
  const defaultProjectColor = useDefaultProjectColor() as ProjectColor
  const _confirmTerminalClose = useConfirmTerminalClose()
  const terminalUrlOpenMode = useTerminalUrlOpenMode()
  const acpTurnTimeoutSecs = useAcpTurnTimeout()
  const editorAutoSave = useEditorAutoSave()
  const editorAutoSaveDelayMs = useEditorAutoSaveDelayMs()
  const notifyOnTerminalIdle = useNotifyOnTerminalIdle()
  const notifyOnAgentChatTurnFinished = useNotifyOnAgentChatTurnFinished()
  const notifyOnAgentChatNeedsYou = useNotifyOnAgentChatNeedsYou()
  const acpTurnIdleTimeoutSecs = useAcpTurnIdleTimeout()
  const acpSessionNewTimeoutSecs = useAcpSessionNewTimeout()
  const acpSessionReopenTimeoutSecs = useAcpSessionReopenTimeout()
  const agentIdleWindowSecs = useAgentIdleWindow()
  const updateSetting = useUpdateAppSetting()
  const resetSettings = useResetAppSettings()

  const [availableShells, setAvailableShells] = useState<DetectedShells | null>(null)
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false)
  const [isResetShortcutsDialogOpen, setIsResetShortcutsDialogOpen] = useState(false)

  // Keyboard shortcuts
  const shortcuts = useKeyboardShortcutsStore((state) => state.shortcuts)
  const updateShortcut = useUpdateShortcut()
  const resetShortcut = useResetShortcut()
  const resetAllShortcuts = useResetAllShortcuts()

  // Updater state
  const {
    isChecking,
    updateAvailable,
    version,
    lastChecked,
    autoUpdateEnabled,
    skippedVersion,
    error: updateError,
    isManualUpdateMode,
    updateChannel
  } = useUpdaterState()
  const { checkForUpdates, installAndRestart, setAutoUpdateEnabled, setUpdateChannel } =
    useUpdaterActions()

  // Load available shells
  useEffect(() => {
    async function loadShells(): Promise<void> {
      try {
        const result = await shellApi.getAvailableShells()
        if (result.success && result.data) {
          setAvailableShells(result.data)
        }
      } catch {
        // Silently fail - user will see empty dropdown with System Default option
      }
    }
    void loadShells()
  }, [])

  const handleFontFamilyChange = (value: string) => {
    updateSetting('terminalFontFamily', value)
  }

  const handleFontSizeChange = (value: number) => {
    updateSetting('terminalFontSize', value)
  }

  const handleUiZoomChange = (value: number) => {
    updateSetting('uiZoomLevel', value)
  }

  const handleUiZoomReset = () => {
    updateSetting('uiZoomLevel', UI_ZOOM_DEFAULT)
  }

  const handleBufferSizeChange = (value: number) => {
    updateSetting('terminalBufferSize', value)
  }

  const handleRendererChange = (value: string) => {
    if (value === 'auto' || value === 'webgl' || value === 'dom') {
      updateSetting('terminalRenderer', value)
    }
  }

  const handleScreenReaderModeChange = async (enabled: boolean) => {
    await updateSetting('terminalScreenReaderMode', enabled)
    // Boundary log (not a failure): the setting only reaches terminals created
    // after the toggle, and xterm.js #3467 / repo #267 can double typed bytes.
    void logFrontendError({
      level: 'info',
      source: 'AppPreferences.terminalScreenReaderMode',
      message: `Terminal screen reader mode ${enabled ? 'enabled' : 'disabled'}; applies to new terminals only (can repeat typed characters, xterm.js #3467 / repo #267)`
    })
  }

  const handleDefaultShellChange = (value: string) => {
    updateSetting('defaultShell', value)
  }

  const handleDefaultProjectColorChange = (value: ProjectColor) => {
    updateSetting('defaultProjectColor', value)
  }

  const isTerminalUrlOpenMode = (value: string): value is TerminalUrlOpenMode =>
    TERMINAL_URL_OPEN_MODE_OPTIONS.some((option) => option.value === value)

  const handleTerminalUrlOpenModeChange = (value: string) => {
    if (!isTerminalUrlOpenMode(value)) {
      return
    }

    updateSetting('terminalUrlOpenMode', value)
  }

  const _handleConfirmTerminalCloseToggle = async (enabled: boolean) => {
    await updateSetting('confirmTerminalClose', enabled)
  }

  const handleAcpTurnTimeoutChange = async (value: number | null) => {
    await updateSetting('acpTurnTimeoutSecs', value)
    // Push to the Rust core so the next turn picks up the new hard cap.
    try {
      await acpApi.setTurnTimeout(value)
    } catch (error) {
      console.error('Failed to apply ACP turn timeout:', error)
    }
  }

  const handleEditorAutoSaveToggle = async (enabled: boolean) => {
    await updateSetting('editorAutoSave', enabled)
    // Cover buffers that were already dirty when the setting was turned on.
    if (enabled) {
      scheduleAllDirtyAutoSaves()
    }
  }

  const handleEditorAutoSaveDelayChange = async (value: number) => {
    await updateSetting('editorAutoSaveDelayMs', value)
  }

  const handleNotifyOnTerminalIdleToggle = async (enabled: boolean) => {
    await updateSetting('notifyOnTerminalIdle', enabled)
  }

  const handleNotifyOnAgentChatTurnFinishedToggle = async (enabled: boolean) => {
    await updateSetting('notifyOnAgentChatTurnFinished', enabled)
  }

  const handleNotifyOnAgentChatNeedsYouToggle = async (enabled: boolean) => {
    await updateSetting('notifyOnAgentChatNeedsYou', enabled)
  }

  const handleAcpTurnIdleTimeoutChange = async (value: number | null) => {
    await updateSetting('acpTurnIdleTimeoutSecs', value)
    // Push to the Rust core so the next turn picks up the new idle window.
    try {
      await acpApi.setTurnIdleTimeout(value)
    } catch (error) {
      console.error('Failed to apply ACP turn idle timeout:', error)
    }
  }

  const handleAcpSessionNewTimeoutChange = async (value: number | null) => {
    await updateSetting('acpSessionNewTimeoutSecs', value)
    // Push to the Rust core so the next session/new picks up the new budget.
    try {
      await acpApi.setSessionNewTimeout(value)
    } catch (error) {
      console.error('Failed to apply ACP session/new timeout:', error)
    }
  }

  const handleAcpSessionReopenTimeoutChange = async (value: number | null) => {
    await updateSetting('acpSessionReopenTimeoutSecs', value)
    // Push to the Rust core so the next session/load|resume uses the new budget.
    try {
      await acpApi.setSessionReopenTimeout(value)
    } catch (error) {
      console.error('Failed to apply ACP session reopen timeout:', error)
    }
  }

  const handleAgentIdleWindowChange = async (value: number | null) => {
    const push = queueAgentIdleWindowPush(value)
    await updateSetting('agentIdleWindowSecs', value)
    await push
  }

  const handleResetConfirm = async () => {
    await resetSettings()
    await resetAllShortcuts()
    setIsResetDialogOpen(false)
  }

  const handleResetShortcutsConfirm = async () => {
    await resetAllShortcuts()
    setIsResetShortcutsDialogOpen(false)
  }

  const handleAutoUpdateToggle = async (enabled: boolean) => {
    await setAutoUpdateEnabled(enabled)
  }

  return (
    <>
      <SettingsModal
        isOpen={isOpen}
        onClose={close}
        title="Application Preferences"
        subtitle="Configure global application settings"
      >
        {/* Content */}
        <SettingsLayout
          title="Preferences"
          categories={APP_PREF_CATEGORIES}
          searchIndex={APP_PREF_SEARCH_INDEX}
        >
          {/* Terminal Appearance Section */}
          <AppearanceSection
            fontFamily={fontFamily}
            fontSize={fontSize}
            uiZoomLevel={uiZoomLevel}
            bufferSize={bufferSize}
            terminalRenderer={terminalRenderer}
            screenReaderMode={terminalScreenReaderMode}
            handleFontFamilyChange={handleFontFamilyChange}
            handleFontSizeChange={handleFontSizeChange}
            handleUiZoomChange={handleUiZoomChange}
            handleUiZoomReset={handleUiZoomReset}
            handleBufferSizeChange={handleBufferSizeChange}
            handleRendererChange={handleRendererChange}
            handleScreenReaderModeChange={handleScreenReaderModeChange}
          />
          {/* Default Shell Section */}
          <ShellSection
            defaultShell={defaultShell}
            availableShells={availableShells}
            handleDefaultShellChange={handleDefaultShellChange}
          />
          {/* Terminal Behavior Section */}
          <BehaviorSection
            terminalUrlOpenMode={terminalUrlOpenMode}
            editorAutoSave={editorAutoSave}
            editorAutoSaveDelayMs={editorAutoSaveDelayMs}
            notifyOnTerminalIdle={notifyOnTerminalIdle}
            notifyOnAgentChatTurnFinished={notifyOnAgentChatTurnFinished}
            notifyOnAgentChatNeedsYou={notifyOnAgentChatNeedsYou}
            handleTerminalUrlOpenModeChange={handleTerminalUrlOpenModeChange}
            handleEditorAutoSaveToggle={handleEditorAutoSaveToggle}
            handleEditorAutoSaveDelayChange={handleEditorAutoSaveDelayChange}
            handleNotifyOnTerminalIdleToggle={handleNotifyOnTerminalIdleToggle}
            handleNotifyOnAgentChatTurnFinishedToggle={handleNotifyOnAgentChatTurnFinishedToggle}
            handleNotifyOnAgentChatNeedsYouToggle={handleNotifyOnAgentChatNeedsYouToggle}
          />
          {/* New Project Defaults Section */}
          <ProjectDefaultsSection
            defaultProjectColor={defaultProjectColor}
            handleDefaultProjectColorChange={handleDefaultProjectColorChange}
          />
          {/* AI Agents Section */}
          <AiAgentsSection
            acpTurnTimeoutSecs={acpTurnTimeoutSecs}
            acpTurnIdleTimeoutSecs={acpTurnIdleTimeoutSecs}
            acpSessionNewTimeoutSecs={acpSessionNewTimeoutSecs}
            acpSessionReopenTimeoutSecs={acpSessionReopenTimeoutSecs}
            agentIdleWindowSecs={agentIdleWindowSecs}
            handleAcpTurnTimeoutChange={handleAcpTurnTimeoutChange}
            handleAcpTurnIdleTimeoutChange={handleAcpTurnIdleTimeoutChange}
            handleAcpSessionNewTimeoutChange={handleAcpSessionNewTimeoutChange}
            handleAcpSessionReopenTimeoutChange={handleAcpSessionReopenTimeoutChange}
            handleAgentIdleWindowChange={handleAgentIdleWindowChange}
          />
          <ProviderSection />
          <McpServersSection />
          {/* Keyboard Shortcuts Section */}
          <ShortcutsSection
            shortcuts={shortcuts}
            updateShortcut={updateShortcut}
            resetShortcut={resetShortcut}
            setIsResetShortcutsDialogOpen={setIsResetShortcutsDialogOpen}
          />
          {/* Updates Section */}
          <UpdatesSection
            isAurUpdater={isAurUpdater}
            isChecking={isChecking}
            updateAvailable={updateAvailable}
            version={version}
            lastChecked={lastChecked}
            autoUpdateEnabled={autoUpdateEnabled}
            skippedVersion={skippedVersion}
            updateError={updateError}
            isManualUpdateMode={isManualUpdateMode}
            updateChannel={updateChannel}
            checkForUpdates={checkForUpdates}
            installAndRestart={installAndRestart}
            handleAutoUpdateToggle={handleAutoUpdateToggle}
            setUpdateChannel={setUpdateChannel}
          />
          <DiagnosticsSection />
          {/* Reset Section */}
          <ResetSection setIsResetDialogOpen={setIsResetDialogOpen} />
        </SettingsLayout>
      </SettingsModal>

      {/* Reset Confirmation Dialog */}
      <ConfirmDialog
        isOpen={isResetDialogOpen}
        title="Reset Settings"
        message="Are you sure you want to reset all application settings to their default values? This cannot be undone."
        confirmLabel="Reset"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleResetConfirm}
        onCancel={() => setIsResetDialogOpen(false)}
      />

      {/* Reset Shortcuts Confirmation Dialog */}
      <ConfirmDialog
        isOpen={isResetShortcutsDialogOpen}
        title="Reset Keyboard Shortcuts"
        message="Are you sure you want to reset all keyboard shortcuts to their default values?"
        confirmLabel="Reset"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleResetShortcutsConfirm}
        onCancel={() => setIsResetShortcutsDialogOpen(false)}
      />
    </>
  )
}
