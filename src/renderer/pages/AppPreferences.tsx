import type { DetectedShells } from '@shared/types/ipc.types'
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Clipboard,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Keyboard,
  Monitor,
  Network,
  Palette,
  RotateCcw,
  Sliders,
  Terminal,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ShortcutRecorder } from '@/components/ShortcutRecorder'
import { AcpAgentsSettings } from '@/components/settings/AcpAgentsSettings'
import { McpServersSettings } from '@/components/settings/McpServersSettings'
import {
  type SettingsCategory,
  SettingsLayout,
  SettingsSection
} from '@/components/settings/SettingsLayout'
import { useResetAppSettings, useUpdateAppSetting } from '@/hooks/use-app-settings'
import {
  useResetAllShortcuts,
  useResetShortcut,
  useUpdateShortcut
} from '@/hooks/use-keyboard-shortcuts'
import { formatDateTime, formatNumber } from '@/i18n/format'
import { acpApi, logApi, shellApi, terminalApi } from '@/lib/api'
import { availableColors, getColorClasses } from '@/lib/colors'
import { scheduleAllDirtyAutoSaves } from '@/lib/editor-auto-save'
import type { SettingsSearchEntry } from '@/lib/settings-search'
import { isTauriContext } from '@/lib/tauri-runtime'
import { isAurUpdateMode } from '@/lib/tauri-updater-api'
import { cn } from '@/lib/utils'
import {
  useAcpFirstPromptWarmup,
  useAcpSessionNewTimeout,
  useAcpSessionReopenTimeout,
  useAcpTurnIdleTimeout,
  useAcpTurnTimeout,
  useConfirmTerminalClose,
  useDefaultProjectColor,
  useDefaultShell,
  useEditorAutoSave,
  useEditorAutoSaveDelayMs,
  useMaxTerminalsPerProject,
  useOrphanDetectionEnabled,
  useOrphanDetectionTimeout,
  useTerminalBufferSize,
  useTerminalFontFamily,
  useTerminalFontSize,
  useTerminalRenderer,
  useTerminalUrlOpenMode,
  useUiLanguage,
  useUiZoomLevel
} from '@/stores/app-settings-store'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { useUpdaterActions, useUpdaterState } from '@/stores/updater-store'
import type { ProjectColor } from '@/types/project'
import {
  ACP_FIRST_PROMPT_WARMUP_OPTIONS,
  ACP_SESSION_NEW_TIMEOUT_OPTIONS,
  ACP_SESSION_REOPEN_TIMEOUT_OPTIONS,
  ACP_TURN_IDLE_TIMEOUT_OPTIONS,
  ACP_TURN_TIMEOUT_OPTIONS,
  BUFFER_SIZE_OPTIONS,
  DEFAULT_APP_SETTINGS,
  EDITOR_AUTO_SAVE_DELAY_OPTIONS,
  FONT_FAMILY_OPTIONS,
  MAX_TERMINALS_OPTIONS,
  ORPHAN_TIMEOUT_OPTIONS,
  TERMINAL_RENDERER_OPTIONS,
  TERMINAL_URL_OPEN_MODE_OPTIONS,
  type TerminalUrlOpenMode,
  UI_ZOOM_DEFAULT,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  UI_ZOOM_STEP,
  type UiLanguagePreference
} from '@/types/settings'

const APP_PREF_CATEGORY_DEFS = [
  { id: 'appearance', labelKey: 'categories.appearance', icon: <Palette size={16} /> },
  { id: 'shell', labelKey: 'categories.shell', icon: <Terminal size={16} /> },
  { id: 'behavior', labelKey: 'categories.behavior', icon: <Sliders size={16} /> },
  {
    id: 'project-defaults',
    labelKey: 'categories.projectDefaults',
    icon: <Monitor size={16} />
  },
  { id: 'ai-agents', labelKey: 'categories.aiAgents', icon: <Bot size={16} /> },
  { id: 'mcp-servers', labelKey: 'categories.mcpServers', icon: <Network size={16} /> },
  { id: 'shortcuts', labelKey: 'categories.shortcuts', icon: <Keyboard size={16} /> },
  { id: 'updates', labelKey: 'categories.updates', icon: <Download size={16} /> },
  { id: 'diagnostics', labelKey: 'categories.diagnostics', icon: <FileText size={16} /> },
  { id: 'reset', labelKey: 'categories.reset', icon: <RotateCcw size={16} /> }
] as const

const APP_PREF_SEARCH_DEFS = [
  {
    categoryId: 'appearance',
    labelKey: 'appearance.fontFamily',
    descriptionKey: 'appearance.fontFamilyHint',
    keywords: ['typeface', 'monospace']
  },
  {
    categoryId: 'appearance',
    labelKey: 'appearance.fontSizeLabel',
    descriptionKey: 'appearance.fontSizeHint',
    keywords: ['text size', 'zoom']
  },
  {
    categoryId: 'appearance',
    labelKey: 'appearance.uiZoom',
    descriptionKey: 'appearance.zoomHint',
    keywords: ['ui zoom', 'zoom', 'interface scale', 'window zoom', 'magnify']
  },
  {
    categoryId: 'appearance',
    labelKey: 'appearance.bufferSize',
    descriptionKey: 'appearance.bufferHint',
    keywords: ['history', 'lines', 'memory']
  },
  {
    categoryId: 'appearance',
    labelKey: 'appearance.maxTerminals',
    descriptionKey: 'appearance.maxTerminalsHint',
    keywords: ['tabs', 'limit']
  },
  {
    categoryId: 'appearance',
    labelKey: 'appearance.renderer',
    descriptionKey: 'appearance.rendererHint',
    keywords: ['webgl', 'dom', 'gpu']
  },
  {
    categoryId: 'shell',
    labelKey: 'categories.shell',
    descriptionKey: 'shell.description',
    keywords: ['bash', 'zsh', 'powershell', 'fish']
  },
  {
    categoryId: 'behavior',
    labelKey: 'behavior.openLinks',
    descriptionKey: 'behavior.openLinksHint',
    keywords: ['url', 'links', 'browser']
  },
  {
    categoryId: 'behavior',
    labelKey: 'behavior.orphanDetection',
    descriptionKey: 'behavior.orphanDetectionHint',
    keywords: ['cleanup', 'inactive', 'timeout']
  },
  {
    categoryId: 'behavior',
    labelKey: 'behavior.cleanupTimeout',
    descriptionKey: 'behavior.cleanupTimeoutHint',
    keywords: ['orphan', 'inactive']
  },
  {
    categoryId: 'behavior',
    labelKey: 'behavior.autoSave',
    descriptionKey: 'behavior.autoSaveHint',
    keywords: ['editor', 'autosave', 'auto save', 'save']
  },
  {
    categoryId: 'behavior',
    labelKey: 'behavior.autoSaveDelay',
    descriptionKey: 'behavior.autoSaveDelayHint',
    keywords: ['editor', 'autosave', 'delay', 'timeout']
  },
  {
    categoryId: 'project-defaults',
    labelKey: 'projectDefaults.color',
    descriptionKey: 'projectDefaults.colorHint',
    keywords: ['theme', 'appearance']
  },
  {
    categoryId: 'ai-agents',
    labelKey: 'categories.aiAgents',
    descriptionKey: 'aiAgents.description',
    keywords: ['acp', 'agent', 'coding assistant']
  },
  {
    categoryId: 'ai-agents',
    labelKey: 'aiAgents.turnTimeout',
    descriptionKey: 'aiAgents.turnTimeoutHint',
    keywords: ['acp', 'timeout', 'turn', 'hard cap', 'unlimited', 'wedge']
  },
  {
    categoryId: 'mcp-servers',
    labelKey: 'categories.mcpServers',
    descriptionKey: 'mcpServers.description',
    keywords: ['mcp', 'model context protocol', 'stdio', 'http', 'sse']
  },
  {
    categoryId: 'shortcuts',
    labelKey: 'categories.shortcuts',
    descriptionKey: 'shortcuts.description',
    keywords: ['hotkeys', 'bindings', 'keybindings']
  },
  {
    categoryId: 'updates',
    labelKey: 'updates.check',
    descriptionKey: 'updates.description',
    keywords: ['version', 'upgrade']
  },
  {
    categoryId: 'updates',
    labelKey: 'updates.autoUpdate',
    descriptionKey: 'updates.autoUpdateHint',
    keywords: ['automatic', 'version']
  },
  {
    categoryId: 'updates',
    labelKey: 'updates.releaseChannel',
    descriptionKey: 'updates.releaseChannelHint',
    keywords: ['insider', 'nightly', 'stable', 'prerelease', 'beta', 'channel']
  },
  {
    categoryId: 'diagnostics',
    labelKey: 'categories.diagnostics',
    descriptionKey: 'diagnostics.description',
    keywords: ['logs', 'export', 'troubleshoot', 'debug']
  },
  {
    categoryId: 'reset',
    labelKey: 'categories.reset',
    descriptionKey: 'reset.description',
    keywords: ['restore', 'defaults', 'clear']
  }
] as const

const TERMINAL_RENDERER_TRANSLATION_KEYS = {
  auto: 'options.renderer.auto',
  webgl: 'options.renderer.webgl',
  dom: 'options.renderer.dom'
} as const

export default function AppPreferences(): React.JSX.Element {
  const navigate = useNavigate()
  const { t: tSettings } = useTranslation('settings')
  const { t: tCommon } = useTranslation('common')
  const isAurUpdater = isAurUpdateMode()
  const categories = useMemo<SettingsCategory[]>(
    () =>
      APP_PREF_CATEGORY_DEFS.map(({ labelKey, ...category }) => ({
        ...category,
        label: tSettings(labelKey)
      })),
    [tSettings]
  )
  const searchIndex = useMemo<SettingsSearchEntry[]>(
    () =>
      APP_PREF_SEARCH_DEFS.map(({ labelKey, descriptionKey, ...entry }) => ({
        ...entry,
        keywords: [...entry.keywords],
        label: tSettings(labelKey),
        description: tSettings(descriptionKey)
      })),
    [tSettings]
  )

  const formatDurationOption = (seconds: number): string => {
    if (seconds >= 31536000 && seconds % 31536000 === 0) {
      return tSettings('options.years', { count: seconds / 31536000 })
    }
    if (seconds >= 3600 && seconds % 3600 === 0) {
      return tSettings('options.hours', { count: seconds / 3600 })
    }
    if (seconds >= 60 && seconds % 60 === 0) {
      return tSettings('options.minutes', { count: seconds / 60 })
    }
    return tSettings('options.seconds', { count: seconds })
  }

  const formatEditorDelayOption = (milliseconds: number): string =>
    milliseconds === 500
      ? tSettings('options.halfSecond')
      : tSettings('options.seconds', { count: milliseconds / 1000 })
  const fontFamily = useTerminalFontFamily()
  const fontSize = useTerminalFontSize()
  const uiZoomLevel = useUiZoomLevel()
  const languagePreference = useUiLanguage()
  const bufferSize = useTerminalBufferSize()
  const terminalRenderer = useTerminalRenderer()
  const defaultShell = useDefaultShell()
  const defaultProjectColor = useDefaultProjectColor() as ProjectColor
  const maxTerminals = useMaxTerminalsPerProject()
  const orphanDetectionEnabled = useOrphanDetectionEnabled()
  const orphanDetectionTimeout = useOrphanDetectionTimeout()
  const _confirmTerminalClose = useConfirmTerminalClose()
  const terminalUrlOpenMode = useTerminalUrlOpenMode()
  const acpTurnTimeoutSecs = useAcpTurnTimeout()
  const editorAutoSave = useEditorAutoSave()
  const editorAutoSaveDelayMs = useEditorAutoSaveDelayMs()
  const acpTurnIdleTimeoutSecs = useAcpTurnIdleTimeout()
  const acpSessionNewTimeoutSecs = useAcpSessionNewTimeout()
  const acpSessionReopenTimeoutSecs = useAcpSessionReopenTimeout()
  const acpFirstPromptWarmupSecs = useAcpFirstPromptWarmup()
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

  const handleLanguageChange = (value: string) => {
    if (value === 'system' || value === 'en' || value === 'zh-CN') {
      updateSetting('uiLanguage', value as UiLanguagePreference)
    }
  }

  const handleBufferSizeChange = (value: number) => {
    updateSetting('terminalBufferSize', value)
  }

  const handleRendererChange = (value: string) => {
    if (value === 'auto' || value === 'webgl' || value === 'dom') {
      updateSetting('terminalRenderer', value)
    }
  }

  const handleDefaultShellChange = (value: string) => {
    updateSetting('defaultShell', value)
  }

  const handleDefaultProjectColorChange = (value: ProjectColor) => {
    updateSetting('defaultProjectColor', value)
  }

  const handleMaxTerminalsChange = (value: number) => {
    updateSetting('maxTerminalsPerProject', value)
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

  const handleOrphanDetectionToggle = async (enabled: boolean) => {
    await updateSetting('orphanDetectionEnabled', enabled)
    // Apply to PtyManager immediately
    try {
      await terminalApi.updateOrphanDetection(enabled, orphanDetectionTimeout)
    } catch (error) {
      console.error('Failed to update orphan detection:', error)
    }
  }

  const handleOrphanTimeoutChange = async (value: number | null) => {
    await updateSetting('orphanDetectionTimeout', value)
    // Apply to PtyManager immediately
    try {
      await terminalApi.updateOrphanDetection(orphanDetectionEnabled, value)
    } catch (error) {
      console.error('Failed to update orphan detection timeout:', error)
    }
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

  const handleAcpFirstPromptWarmupChange = async (value: number | null) => {
    await updateSetting('acpFirstPromptWarmupSecs', value)
    // Push to the Rust core so the next session creation uses the new warmup
    // budget (0 disables the warmup entirely).
    try {
      await acpApi.setFirstPromptWarmupTimeout(value)
    } catch (error) {
      console.error('Failed to apply ACP first-prompt warmup timeout:', error)
    }
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

  const formatLastChecked = (date: Date | null): string => {
    if (!date) return tCommon('status.never')
    return formatDateTime(date)
  }

  return (
    <>
      <main className="flex-1 flex flex-col min-w-0 h-full relative">
        {/* Header */}
        <div className="h-16 flex items-center justify-between px-8 border-b border-border bg-card flex-shrink-0">
          <div>
            <h1 className="text-xl font-semibold text-foreground leading-tight">
              {tSettings('page.title')}
            </h1>
            <p className="text-xs text-muted-foreground">{tSettings('page.subtitle')}</p>
          </div>
          <button
            onClick={() => {
              navigate('/')
            }}
            className="group flex items-center justify-center h-8 w-8 rounded-md hover:bg-secondary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            title={tCommon('actions.close')}
            aria-label={tCommon('actions.close')}
          >
            <X size={18} className="text-muted-foreground group-hover:text-foreground" />
          </button>
        </div>

        {/* Content */}
        <SettingsLayout categories={categories} searchIndex={searchIndex}>
          {/* Terminal Appearance Section */}
          <SettingsSection id="appearance">
            <div className="flex items-start gap-6 border-b border-border pb-6">
              <div className="w-1/3 pt-1">
                <h2 className="text-lg font-medium text-foreground">
                  {tSettings('categories.appearance')}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {tSettings('appearance.description')}
                </p>
              </div>
              <div className="w-2/3 space-y-4">
                <div>
                  <label
                    htmlFor="ui-language"
                    className="block text-sm font-medium text-secondary-foreground mb-2"
                  >
                    {tSettings('language.title')}
                  </label>
                  <select
                    id="ui-language"
                    value={languagePreference}
                    onChange={(event) => handleLanguageChange(event.target.value)}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                  >
                    <option value="system">{tSettings('language.system')}</option>
                    <option value="en">{tSettings('language.english')}</option>
                    <option value="zh-CN">{tSettings('language.simplifiedChinese')}</option>
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('language.systemHint')}
                  </p>
                </div>

                {/* UI Zoom Level (whole interface) */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-secondary-foreground">
                      {tSettings('appearance.uiZoom')}
                    </label>
                    <button
                      type="button"
                      onClick={handleUiZoomReset}
                      className="text-xs text-primary hover:underline disabled:opacity-50"
                      disabled={uiZoomLevel === UI_ZOOM_DEFAULT}
                    >
                      {tSettings('appearance.resetZoom')}
                    </button>
                  </div>
                  <div className="flex items-center gap-4">
                    <input
                      type="range"
                      min={UI_ZOOM_MIN}
                      max={UI_ZOOM_MAX}
                      step={UI_ZOOM_STEP}
                      value={uiZoomLevel}
                      onChange={(e) => handleUiZoomChange(parseFloat(e.target.value))}
                      className="flex-1 h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
                    />
                    <span className="text-sm text-muted-foreground w-14 text-right">
                      {Math.round(uiZoomLevel * 100)}%
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('appearance.zoomHint')}
                  </p>
                </div>

                {/* Font Family */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('appearance.fontFamily')}
                  </label>
                  <select
                    value={fontFamily}
                    onChange={(e) => handleFontFamilyChange(e.target.value)}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                  >
                    {FONT_FAMILY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('appearance.fontFamilyHint')}
                  </p>
                </div>

                {/* Font Size */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('appearance.fontSize', { size: fontSize })}
                  </label>
                  <div className="flex items-center gap-4">
                    <input
                      type="range"
                      min={10}
                      max={24}
                      value={fontSize}
                      onChange={(e) => handleFontSizeChange(parseInt(e.target.value, 10))}
                      className="flex-1 h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-primary"
                    />
                    <span className="text-sm text-muted-foreground w-12 text-right">
                      {fontSize}px
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('appearance.fontSizeHint')}
                  </p>
                </div>

                {/* Buffer Size */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('appearance.bufferSize')}
                  </label>
                  <select
                    value={bufferSize}
                    onChange={(e) => handleBufferSizeChange(parseInt(e.target.value, 10))}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                  >
                    {BUFFER_SIZE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {tSettings('options.lineCount', {
                          count: option.value,
                          formattedCount: formatNumber(option.value)
                        })}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('appearance.bufferHint')}
                  </p>
                </div>

                {/* Max Terminals */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('appearance.maxTerminals')}
                  </label>
                  <select
                    value={maxTerminals}
                    onChange={(e) => handleMaxTerminalsChange(parseInt(e.target.value, 10))}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                  >
                    {MAX_TERMINALS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {tSettings('options.terminalCount', { count: option.value })}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('appearance.maxTerminalsHint')}
                  </p>
                </div>

                {/* Terminal Renderer */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('appearance.renderer')}
                  </label>
                  <select
                    value={terminalRenderer}
                    onChange={(e) => handleRendererChange(e.target.value)}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                  >
                    {TERMINAL_RENDERER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {tSettings(TERMINAL_RENDERER_TRANSLATION_KEYS[option.value])}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('appearance.rendererHint')}
                  </p>
                </div>

                {/* Preview */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('appearance.preview')}
                  </label>
                  <div
                    className="bg-terminal-bg border border-border rounded-md p-4 text-terminal-fg"
                    style={{
                      fontFamily: fontFamily,
                      fontSize: `${fontSize}px`,
                      lineHeight: 1.2
                    }}
                  >
                    <div>$ echo "Hello, World!"</div>
                    <div>Hello, World!</div>
                    <div>$ ls -la</div>
                    <div>drwxr-xr-x 5 user staff 160 Jan 11 10:00 .</div>
                  </div>
                </div>
              </div>
            </div>
          </SettingsSection>

          {/* Default Shell Section */}
          <SettingsSection id="shell">
            <div className="flex items-start gap-6 border-b border-border pb-6">
              <div className="w-1/3 pt-1">
                <h2 className="text-lg font-medium text-foreground">
                  {tSettings('categories.shell')}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {tSettings('shell.description')}
                </p>
              </div>
              <div className="w-2/3 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('shell.label')}
                  </label>
                  <select
                    value={(() => {
                      // Normalize the stored defaultShell for display
                      // If it's a path, use it directly; if it's a name, find matching shell's path
                      if (!defaultShell) return ''
                      if (defaultShell.includes('\\') || defaultShell.includes('/')) {
                        return defaultShell
                      }
                      // Find shell by name or by basename of path
                      const match = availableShells?.available.find((s) => {
                        if (s.name === defaultShell) return true
                        const pathBasename = s.path.split(/[\\/]/).pop()
                        return pathBasename === defaultShell
                      })
                      return match?.path ?? defaultShell
                    })()}
                    onChange={(e) => handleDefaultShellChange(e.target.value)}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                  >
                    <option value="">{tSettings('shell.systemDefault')}</option>
                    {availableShells?.available?.map((shell) => (
                      <option key={shell.path} value={shell.path}>
                        {shell.displayName}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('shell.overrideHint')}
                  </p>
                </div>
              </div>
            </div>
          </SettingsSection>

          {/* Terminal Behavior Section */}
          <SettingsSection id="behavior">
            <div className="flex items-start gap-6 border-b border-border pb-6">
              <div className="w-1/3 pt-1">
                <h2 className="text-lg font-medium text-foreground">
                  {tSettings('categories.behavior')}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {tSettings('behavior.description')}
                </p>
              </div>
              <div className="w-2/3 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('behavior.openLinks')}
                  </label>
                  <select
                    value={terminalUrlOpenMode}
                    onChange={(e) => handleTerminalUrlOpenModeChange(e.target.value)}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                  >
                    {TERMINAL_URL_OPEN_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {tSettings(`options.urlMode.${option.value}`)}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('behavior.openLinksHint')}
                  </p>
                </div>

                {/* Orphan Detection Toggle */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('behavior.orphanDetection')}
                  </label>
                  <div className="flex items-center justify-between bg-secondary/30 border border-border rounded-md px-4 py-3">
                    <div className="flex-1">
                      <div className="text-sm text-foreground">
                        {tSettings('behavior.enableOrphanDetection')}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {tSettings('behavior.orphanDetectionHint')}
                      </div>
                    </div>
                    <button
                      onClick={() => handleOrphanDetectionToggle(!orphanDetectionEnabled)}
                      className={cn(
                        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
                        orphanDetectionEnabled ? 'bg-primary' : 'bg-input'
                      )}
                    >
                      <span
                        className={cn(
                          'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                          orphanDetectionEnabled ? 'translate-x-6' : 'translate-x-1'
                        )}
                      />
                    </button>
                  </div>
                </div>

                {/* Timeout Dropdown */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('behavior.cleanupTimeout')}
                  </label>
                  <select
                    value={orphanDetectionTimeout ?? 600000}
                    onChange={(e) =>
                      handleOrphanTimeoutChange(
                        e.target.value ? parseInt(e.target.value, 10) : null
                      )
                    }
                    disabled={!orphanDetectionEnabled}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {ORPHAN_TIMEOUT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {formatDurationOption(option.value / 1000)}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('behavior.cleanupTimeoutHint')}
                  </p>
                </div>

                {/* Editor Auto Save Toggle (GH-539) */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('behavior.autoSave')}
                  </label>
                  <div className="flex items-center justify-between bg-secondary/30 border border-border rounded-md px-4 py-3">
                    <div className="flex-1">
                      <div className="text-sm text-foreground">
                        {tSettings('behavior.enableAutoSave')}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {tSettings('behavior.autoSaveHint')}
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={editorAutoSave}
                      aria-label={tSettings('behavior.enableAutoSave')}
                      onClick={() => handleEditorAutoSaveToggle(!editorAutoSave)}
                      className={cn(
                        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
                        editorAutoSave ? 'bg-primary' : 'bg-input'
                      )}
                    >
                      <span
                        className={cn(
                          'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                          editorAutoSave ? 'translate-x-6' : 'translate-x-1'
                        )}
                      />
                    </button>
                  </div>
                </div>

                {/* Auto Save Delay Dropdown (GH-539) */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('behavior.autoSaveDelay')}
                  </label>
                  <select
                    value={
                      EDITOR_AUTO_SAVE_DELAY_OPTIONS.some(
                        (option) => option.value === editorAutoSaveDelayMs
                      )
                        ? editorAutoSaveDelayMs
                        : DEFAULT_APP_SETTINGS.editorAutoSaveDelayMs
                    }
                    onChange={(e) => handleEditorAutoSaveDelayChange(parseInt(e.target.value, 10))}
                    disabled={!editorAutoSave}
                    aria-label={tSettings('behavior.autoSaveDelayAria')}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {EDITOR_AUTO_SAVE_DELAY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {formatEditorDelayOption(option.value)}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('behavior.autoSaveDelayHint')}
                  </p>
                </div>
              </div>
            </div>
          </SettingsSection>

          {/* New Project Defaults Section */}
          <SettingsSection id="project-defaults">
            <div className="flex items-start gap-6 border-b border-border pb-6">
              <div className="w-1/3 pt-1">
                <h2 className="text-lg font-medium text-foreground">
                  {tSettings('categories.projectDefaults')}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {tSettings('projectDefaults.description')}
                </p>
              </div>
              <div className="w-2/3 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('projectDefaults.color')}
                  </label>
                  <div className="flex gap-2 flex-wrap">
                    {availableColors.map((color) => {
                      const colors = getColorClasses(color)
                      return (
                        <button
                          key={color}
                          onClick={() => handleDefaultProjectColorChange(color)}
                          className={cn(
                            'w-8 h-8 rounded-full transition-all',
                            colors.bg,
                            defaultProjectColor === color
                              ? 'ring-2 ring-offset-2 ring-offset-background ring-current'
                              : 'hover:opacity-80'
                          )}
                          title={tSettings(`projectDefaults.colors.${color}`, {
                            defaultValue: color
                          })}
                        />
                      )
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {tSettings('projectDefaults.colorHint')}
                  </p>
                </div>
              </div>
            </div>
          </SettingsSection>

          {/* AI Agents Section */}
          <SettingsSection id="ai-agents">
            <div className="flex items-start gap-6 border-b border-border pb-6">
              <div className="w-1/3 pt-1">
                <div className="flex items-center gap-2">
                  <Bot size={18} className="text-primary" />
                  <h2 className="text-lg font-medium text-foreground">
                    {tSettings('categories.aiAgents')}
                  </h2>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {tSettings('aiAgents.description')}
                </p>
              </div>
              <div className="w-2/3 space-y-4">
                <AcpAgentsSettings />
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('aiAgents.turnTimeout')}
                  </label>
                  <select
                    value={acpTurnTimeoutSecs === null ? 'null' : String(acpTurnTimeoutSecs)}
                    onChange={(e) =>
                      handleAcpTurnTimeoutChange(
                        e.target.value === 'null' ? null : parseInt(e.target.value, 10)
                      )
                    }
                    disabled={!isTauriContext()}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {ACP_TURN_TIMEOUT_OPTIONS.map((option) => (
                      <option
                        key={option.value === null ? 'null' : String(option.value)}
                        value={option.value === null ? 'null' : String(option.value)}
                      >
                        {option.value === null
                          ? tSettings('options.environmentUnlimited')
                          : formatDurationOption(option.value)}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('aiAgents.turnTimeoutHint')}
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="acp-turn-idle-timeout"
                    className="block text-sm font-medium text-secondary-foreground mb-2"
                  >
                    {tSettings('aiAgents.turnIdleTimeout')}
                  </label>
                  <select
                    id="acp-turn-idle-timeout"
                    value={
                      acpTurnIdleTimeoutSecs === null ? 'null' : String(acpTurnIdleTimeoutSecs)
                    }
                    onChange={(e) =>
                      handleAcpTurnIdleTimeoutChange(
                        e.target.value === 'null' ? null : parseInt(e.target.value, 10)
                      )
                    }
                    disabled={!isTauriContext()}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {ACP_TURN_IDLE_TIMEOUT_OPTIONS.map((option) => (
                      <option
                        key={option.value === null ? 'null' : String(option.value)}
                        value={option.value === null ? 'null' : String(option.value)}
                      >
                        {option.value === null
                          ? tSettings('options.environmentUnlimited')
                          : formatDurationOption(option.value)}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('aiAgents.turnIdleTimeoutHint')}
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="acp-session-new-timeout"
                    className="block text-sm font-medium text-secondary-foreground mb-2"
                  >
                    {tSettings('aiAgents.sessionNewTimeout')}
                  </label>
                  <select
                    id="acp-session-new-timeout"
                    value={
                      acpSessionNewTimeoutSecs === null ? 'null' : String(acpSessionNewTimeoutSecs)
                    }
                    onChange={(e) =>
                      handleAcpSessionNewTimeoutChange(
                        e.target.value === 'null' ? null : parseInt(e.target.value, 10)
                      )
                    }
                    disabled={!isTauriContext()}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {ACP_SESSION_NEW_TIMEOUT_OPTIONS.map((option) => (
                      <option
                        key={option.value === null ? 'null' : String(option.value)}
                        value={option.value === null ? 'null' : String(option.value)}
                      >
                        {option.value === null
                          ? tSettings('options.environment60Seconds')
                          : formatDurationOption(option.value)}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('aiAgents.sessionNewTimeoutHint')}
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="acp-session-reopen-timeout"
                    className="block text-sm font-medium text-secondary-foreground mb-2"
                  >
                    {tSettings('aiAgents.sessionReopenTimeout')}
                  </label>
                  <select
                    id="acp-session-reopen-timeout"
                    value={
                      acpSessionReopenTimeoutSecs === null
                        ? 'null'
                        : String(acpSessionReopenTimeoutSecs)
                    }
                    onChange={(e) =>
                      handleAcpSessionReopenTimeoutChange(
                        e.target.value === 'null' ? null : parseInt(e.target.value, 10)
                      )
                    }
                    disabled={!isTauriContext()}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {ACP_SESSION_REOPEN_TIMEOUT_OPTIONS.map((option) => (
                      <option
                        key={option.value === null ? 'null' : String(option.value)}
                        value={option.value === null ? 'null' : String(option.value)}
                      >
                        {option.value === null
                          ? tSettings('options.environment60Seconds')
                          : formatDurationOption(option.value)}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('aiAgents.sessionReopenTimeoutHint')}
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="acp-first-prompt-warmup"
                    className="block text-sm font-medium text-secondary-foreground mb-2"
                  >
                    {tSettings('aiAgents.firstPromptWarmup')}
                  </label>
                  <select
                    id="acp-first-prompt-warmup"
                    value={
                      acpFirstPromptWarmupSecs === null ? 'null' : String(acpFirstPromptWarmupSecs)
                    }
                    onChange={(e) =>
                      handleAcpFirstPromptWarmupChange(
                        e.target.value === 'null' ? null : parseInt(e.target.value, 10)
                      )
                    }
                    disabled={!isTauriContext()}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {ACP_FIRST_PROMPT_WARMUP_OPTIONS.map((option) => (
                      <option
                        key={option.value === null ? 'null' : String(option.value)}
                        value={option.value === null ? 'null' : String(option.value)}
                      >
                        {option.value === null
                          ? tSettings('options.environment45Seconds')
                          : option.value === 0
                            ? tSettings('options.disabled')
                            : formatDurationOption(option.value)}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tSettings('aiAgents.firstPromptWarmupHint')}
                  </p>
                </div>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection id="mcp-servers">
            <div className="flex flex-col gap-6 border-b border-border pb-6 lg:flex-row lg:items-start">
              <div className="w-full pt-1 lg:w-1/3">
                <div className="flex items-center gap-2">
                  <Network size={18} className="text-primary" />
                  <h2 className="text-lg font-medium text-foreground">
                    {tSettings('categories.mcpServers')}
                  </h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {tSettings('mcpServers.description')}
                </p>
              </div>
              <div className="w-full lg:w-2/3">
                <McpServersSettings />
              </div>
            </div>
          </SettingsSection>

          {/* Keyboard Shortcuts Section */}
          <SettingsSection id="shortcuts">
            <div className="flex items-start gap-6 border-b border-border pb-6">
              <div className="w-1/3 pt-1">
                <div className="flex items-center gap-2">
                  <Keyboard size={18} className="text-primary" />
                  <h2 className="text-lg font-medium text-foreground">
                    {tSettings('categories.shortcuts')}
                  </h2>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {tSettings('shortcuts.description')}
                </p>
                <button
                  onClick={() => setIsResetShortcutsDialogOpen(true)}
                  className="mt-4 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RotateCcw size={12} />
                  {tSettings('shortcuts.resetAll')}
                </button>
              </div>
              <div className="w-2/3 space-y-4">
                {Object.values(shortcuts).map((shortcut) => (
                  <ShortcutRecorder
                    key={shortcut.id}
                    shortcut={shortcut}
                    allShortcuts={shortcuts}
                    onUpdate={updateShortcut}
                    onReset={resetShortcut}
                  />
                ))}
              </div>
            </div>
          </SettingsSection>

          {/* Updates Section */}
          <SettingsSection id="updates">
            <div className="flex items-start gap-6 border-b border-border pb-6">
              <div className="w-1/3 pt-1">
                <div className="flex items-center gap-2">
                  <Download size={18} className="text-primary" />
                  <h2 className="text-lg font-medium text-foreground">
                    {tSettings('categories.updates')}
                  </h2>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {tSettings('updates.description')}
                </p>
              </div>
              <div className="w-2/3 space-y-4">
                {/* Current Version */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('updates.currentVersion')}
                  </label>
                  <div className="bg-secondary/30 border border-border rounded-md px-4 py-3">
                    <span className="text-sm font-mono text-foreground">
                      v{import.meta.env.PACKAGE_VERSION || '0.1.0'}
                    </span>
                  </div>
                </div>

                {/* Release Channel */}
                {!isAurUpdater && (
                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-2">
                      {tSettings('updates.releaseChannel')}
                    </label>
                    <div className="space-y-2">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {(['stable', 'insider', 'nightly'] as const).map((channel) => {
                          const option = { id: channel }
                          const active = updateChannel === option.id
                          return (
                            <button
                              key={option.id}
                              type="button"
                              onClick={() => setUpdateChannel(option.id)}
                              aria-pressed={active}
                              disabled={isChecking}
                              className={cn(
                                'flex flex-col items-start gap-0.5 px-3 py-2.5 border rounded-lg text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                                active
                                  ? 'bg-primary/10 border-primary'
                                  : 'bg-secondary/30 border-border hover:bg-secondary/60'
                              )}
                            >
                              <span
                                className={cn(
                                  'text-sm font-medium',
                                  active ? 'text-primary' : 'text-foreground'
                                )}
                              >
                                {tSettings(`updates.channels.${option.id}`)}
                              </span>
                              <span className="text-3xs text-muted-foreground font-normal">
                                {tSettings(`updates.channels.${option.id}Description`)}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                      {updateChannel !== 'stable' && (
                        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2.5">
                          <AlertCircle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
                          <div className="text-xs text-foreground">
                            {updateChannel === 'nightly'
                              ? tSettings('updates.nightlyWarning')
                              : tSettings('updates.insiderWarning')}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Update Status */}
                {updateAvailable && version && (
                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-2">
                      {tSettings('updates.available')}
                    </label>
                    <div
                      className={cn(
                        'border rounded-md px-4 py-3 flex items-center gap-3',
                        isManualUpdateMode
                          ? 'bg-amber-500/10 border-amber-500/20'
                          : 'bg-green-500/10 border-green-500/20'
                      )}
                    >
                      <CheckCircle2
                        size={18}
                        className={cn(
                          'flex-shrink-0',
                          isManualUpdateMode ? 'text-amber-500' : 'text-green-500'
                        )}
                      />
                      <div className="flex-1">
                        <div className="text-sm font-medium text-foreground">
                          {tSettings('updates.versionAvailable', { version })}
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {isAurUpdater
                            ? tSettings('updates.aurHint')
                            : isManualUpdateMode
                              ? tSettings('updates.manualHint')
                              : tSettings('updates.downloadHint')}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Update Error */}
                {updateError && (
                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-2">
                      {tSettings('updates.error')}
                    </label>
                    <div className="bg-red-500/10 border border-red-500/20 rounded-md px-4 py-3 flex items-center gap-3">
                      <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
                      <div className="flex-1">
                        <div className="text-sm text-foreground">{updateError}</div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Check for Updates Button */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('updates.check')}
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={checkForUpdates}
                      disabled={isChecking}
                      className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 disabled:bg-primary/50 disabled:cursor-not-allowed border border-primary rounded-lg text-sm text-primary-foreground transition-colors"
                    >
                      <Download size={16} />
                      {isChecking ? tSettings('updates.checking') : tSettings('updates.check')}
                    </button>
                    {updateAvailable && isManualUpdateMode && (
                      <button
                        onClick={installAndRestart}
                        className="flex items-center gap-2 px-4 py-2 bg-amber-500 hover:bg-amber-500/90 border border-amber-500 rounded-lg text-sm text-white transition-colors"
                      >
                        <ExternalLink size={16} />
                        {tSettings('updates.openDownloadPage')}
                      </button>
                    )}
                  </div>
                  {lastChecked && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {tSettings('updates.lastChecked', {
                        date: formatLastChecked(lastChecked)
                      })}
                    </p>
                  )}
                </div>

                {/* Auto-update Toggle */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    {tSettings('updates.autoUpdate')}
                  </label>
                  <div className="flex items-center justify-between bg-secondary/30 border border-border rounded-md px-4 py-3">
                    <div className="flex-1">
                      <div className="text-sm text-foreground">
                        {tSettings('updates.autoUpdateLabel')}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {tSettings('updates.autoUpdateHint')}
                      </div>
                    </div>
                    <button
                      onClick={() => handleAutoUpdateToggle(!autoUpdateEnabled)}
                      className={cn(
                        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
                        autoUpdateEnabled ? 'bg-primary' : 'bg-input'
                      )}
                    >
                      <span
                        className={cn(
                          'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                          autoUpdateEnabled ? 'translate-x-6' : 'translate-x-1'
                        )}
                      />
                    </button>
                  </div>
                </div>

                {/* Skipped Version */}
                {skippedVersion && (
                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-2">
                      {tSettings('updates.skippedVersion')}
                    </label>
                    <div className="bg-secondary/30 border border-border rounded-md px-4 py-3">
                      <div className="text-sm text-foreground">
                        {tSettings('updates.skipping', { version: skippedVersion })}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {tSettings('updates.skippingHint')}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </SettingsSection>

          <SettingsSection id="diagnostics">
            <div className="flex items-start gap-6 border-b border-border pb-6">
              <div className="w-1/3 pt-1">
                <div className="flex items-center gap-2">
                  <FileText size={18} className="text-primary" />
                  <h2 className="text-lg font-medium text-foreground">
                    {tSettings('categories.diagnostics')}
                  </h2>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {tSettings('diagnostics.description')}
                </p>
              </div>
              <div className="w-2/3 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => void logApi.revealLogDir()}
                    className="flex items-center justify-start gap-2.5 px-4 py-3 bg-secondary/30 hover:bg-secondary/60 border border-border rounded-lg text-sm font-medium text-foreground transition-all hover:scale-[1.01] active:scale-[0.99] shadow-sm"
                  >
                    <FolderOpen size={16} className="text-muted-foreground" />
                    <div className="text-left">
                      <div>{tSettings('diagnostics.revealFolder')}</div>
                      <div className="text-3xs text-muted-foreground font-normal">
                        {tSettings('diagnostics.revealFolderHint')}
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => void logApi.exportLogFile()}
                    className="flex items-center justify-start gap-2.5 px-4 py-3 bg-secondary/30 hover:bg-secondary/60 border border-border rounded-lg text-sm font-medium text-foreground transition-all hover:scale-[1.01] active:scale-[0.99] shadow-sm"
                  >
                    <FileText size={16} className="text-muted-foreground" />
                    <div className="text-left">
                      <div>{tSettings('diagnostics.exportFile')}</div>
                      <div className="text-3xs text-muted-foreground font-normal">
                        {tSettings('diagnostics.exportFileHint')}
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => void logApi.copyLogContents()}
                    className="flex items-center justify-start gap-2.5 px-4 py-3 bg-secondary/30 hover:bg-secondary/60 border border-border rounded-lg text-sm font-medium text-foreground transition-all hover:scale-[1.01] active:scale-[0.99] shadow-sm"
                  >
                    <Clipboard size={16} className="text-muted-foreground" />
                    <div className="text-left">
                      <div>{tSettings('diagnostics.copyContents')}</div>
                      <div className="text-3xs text-muted-foreground font-normal">
                        {tSettings('diagnostics.copyContentsHint')}
                      </div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => void logApi.exportLogToDefault()}
                    className="flex items-center justify-start gap-2.5 px-4 py-3 bg-secondary/30 hover:bg-secondary/60 border border-border rounded-lg text-sm font-medium text-foreground transition-all hover:scale-[1.01] active:scale-[0.99] shadow-sm"
                  >
                    <Download size={16} className="text-muted-foreground" />
                    <div className="text-left">
                      <div>{tSettings('diagnostics.exportDefault')}</div>
                      <div className="text-3xs text-muted-foreground font-normal">
                        {tSettings('diagnostics.exportDefaultHint')}
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          </SettingsSection>

          {/* Reset Section */}
          <SettingsSection id="reset">
            <div className="flex items-start gap-6 pb-6">
              <div className="w-1/3 pt-1">
                <h2 className="text-lg font-medium text-foreground">
                  {tSettings('categories.reset')}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {tSettings('reset.description')}
                </p>
              </div>
              <div className="w-2/3">
                <button
                  onClick={() => setIsResetDialogOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-card hover:bg-secondary border border-border rounded-lg text-sm text-foreground transition-colors"
                >
                  <RotateCcw size={16} />
                  {tSettings('reset.button')}
                </button>
              </div>
            </div>
          </SettingsSection>
        </SettingsLayout>
      </main>

      {/* Reset Confirmation Dialog */}
      <ConfirmDialog
        isOpen={isResetDialogOpen}
        title={tSettings('reset.title')}
        message={tSettings('reset.message')}
        confirmLabel={tCommon('actions.reset')}
        cancelLabel={tCommon('actions.cancel')}
        variant="danger"
        onConfirm={handleResetConfirm}
        onCancel={() => setIsResetDialogOpen(false)}
      />

      {/* Reset Shortcuts Confirmation Dialog */}
      <ConfirmDialog
        isOpen={isResetShortcutsDialogOpen}
        title={tSettings('shortcuts.resetTitle')}
        message={tSettings('shortcuts.resetMessage')}
        confirmLabel={tCommon('actions.reset')}
        cancelLabel={tCommon('actions.cancel')}
        variant="danger"
        onConfirm={handleResetShortcutsConfirm}
        onCancel={() => setIsResetShortcutsDialogOpen(false)}
      />
    </>
  )
}
