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
  Terminal
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ShortcutRecorder } from '@/components/ShortcutRecorder'
import { AcpAgentsSettings } from '@/components/settings/AcpAgentsSettings'
import { McpServersSettings } from '@/components/settings/McpServersSettings'
import {
  type SettingsCategory,
  SettingsLayout,
  SettingsSection
} from '@/components/settings/SettingsLayout'
import { SettingsModal } from '@/components/settings/SettingsModal'
import { useResetAppSettings, useUpdateAppSetting } from '@/hooks/use-app-settings'
import {
  useResetAllShortcuts,
  useResetShortcut,
  useUpdateShortcut
} from '@/hooks/use-keyboard-shortcuts'
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
  useUiZoomLevel
} from '@/stores/app-settings-store'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
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
  UI_ZOOM_STEP
} from '@/types/settings'

const APP_PREF_CATEGORIES: SettingsCategory[] = [
  { id: 'appearance', label: 'Terminal Appearance', icon: <Palette size={16} /> },
  { id: 'shell', label: 'Default Shell', icon: <Terminal size={16} /> },
  { id: 'behavior', label: 'Behavior', icon: <Sliders size={16} /> },
  { id: 'project-defaults', label: 'New Project Defaults', icon: <Monitor size={16} /> },
  { id: 'ai-agents', label: 'AI Agents', icon: <Bot size={16} /> },
  { id: 'mcp-servers', label: 'MCP Servers', icon: <Network size={16} /> },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: <Keyboard size={16} /> },
  { id: 'updates', label: 'Updates', icon: <Download size={16} /> },
  { id: 'diagnostics', label: 'Diagnostics & Logs', icon: <FileText size={16} /> },
  { id: 'reset', label: 'Reset Settings', icon: <RotateCcw size={16} /> }
]

const APP_PREF_SEARCH_INDEX: SettingsSearchEntry[] = [
  {
    categoryId: 'appearance',
    label: 'Font Family',
    description: 'Choose a monospace font for terminal text.',
    keywords: ['typeface', 'monospace']
  },
  {
    categoryId: 'appearance',
    label: 'Font Size',
    description: 'Adjust terminal text size.',
    keywords: ['text size', 'zoom']
  },
  {
    categoryId: 'appearance',
    label: 'UI Zoom Level',
    description: 'Zoom the entire interface (50–300%).',
    keywords: ['ui zoom', 'zoom', 'interface scale', 'window zoom', 'magnify']
  },
  {
    categoryId: 'appearance',
    label: 'Scrollback Buffer Size',
    description: 'Number of lines to keep in terminal history.',
    keywords: ['history', 'lines', 'memory']
  },
  {
    categoryId: 'appearance',
    label: 'Max Terminals Per Project',
    description: 'Maximum number of terminal tabs allowed per project.',
    keywords: ['tabs', 'limit']
  },
  {
    categoryId: 'appearance',
    label: 'Terminal Renderer',
    description: 'GPU-accelerated rendering for terminal output.',
    keywords: ['webgl', 'dom', 'gpu']
  },
  {
    categoryId: 'shell',
    label: 'Default Shell',
    description: 'Set the default shell for new terminals.',
    keywords: ['bash', 'zsh', 'powershell', 'fish']
  },
  {
    categoryId: 'behavior',
    label: 'Open Terminal Links In',
    description: 'Choose how URLs from terminal output open.',
    keywords: ['url', 'links', 'browser']
  },
  {
    categoryId: 'behavior',
    label: 'Orphan Detection',
    description: 'Automatically clean up terminals that have been inactive.',
    keywords: ['cleanup', 'inactive', 'timeout']
  },
  {
    categoryId: 'behavior',
    label: 'Timeout Before Cleanup',
    description: 'Duration before inactive terminals are cleaned up.',
    keywords: ['orphan', 'inactive']
  },
  {
    categoryId: 'behavior',
    label: 'Auto Save',
    description: 'Automatically save editor files after you stop typing.',
    keywords: ['editor', 'autosave', 'auto save', 'save']
  },
  {
    categoryId: 'behavior',
    label: 'Auto Save Delay',
    description: 'Idle time before editor files are saved automatically.',
    keywords: ['editor', 'autosave', 'delay', 'timeout']
  },
  {
    categoryId: 'project-defaults',
    label: 'Default Color',
    description: 'New projects will use this color by default.',
    keywords: ['theme', 'appearance']
  },
  {
    categoryId: 'ai-agents',
    label: 'AI Agents',
    description: 'View ACP agent availability and warm/auth status.',
    keywords: ['acp', 'agent', 'coding assistant']
  },
  {
    categoryId: 'ai-agents',
    label: 'Turn Timeout',
    description: 'Maximum wall-clock duration for a single agent turn (hard cap).',
    keywords: ['acp', 'timeout', 'turn', 'hard cap', 'unlimited', 'wedge']
  },
  {
    categoryId: 'mcp-servers',
    label: 'MCP Servers',
    description: 'Manage global stdio, HTTP, and SSE servers for new agent sessions.',
    keywords: ['mcp', 'model context protocol', 'stdio', 'http', 'sse']
  },
  {
    categoryId: 'shortcuts',
    label: 'Keyboard Shortcuts',
    description: 'Customize keyboard shortcuts to match your workflow.',
    keywords: ['hotkeys', 'bindings', 'keybindings']
  },
  {
    categoryId: 'updates',
    label: 'Check for Updates',
    description: 'Manage application updates and version information.',
    keywords: ['version', 'upgrade']
  },
  {
    categoryId: 'updates',
    label: 'Auto-update',
    description: 'Automatically check for updates.',
    keywords: ['automatic', 'version']
  },
  {
    categoryId: 'updates',
    label: 'Release Channel',
    description: 'Choose Stable, Insider, or Nightly update track.',
    keywords: ['insider', 'nightly', 'stable', 'prerelease', 'beta', 'channel']
  },
  {
    categoryId: 'diagnostics',
    label: 'Diagnostics & Logs',
    description: 'Export or copy application logs to troubleshoot issues.',
    keywords: ['logs', 'export', 'troubleshoot', 'debug']
  },
  {
    categoryId: 'reset',
    label: 'Reset Settings',
    description: 'Restore all settings to their default values.',
    keywords: ['restore', 'defaults', 'clear']
  }
]

export function AppPreferencesModal(): React.JSX.Element {
  const isOpen = useSettingsModalStore((state) => state.view === 'app')
  const close = useSettingsModalStore((state) => state.close)
  const isAurUpdater = isAurUpdateMode()
  const fontFamily = useTerminalFontFamily()
  const fontSize = useTerminalFontSize()
  const uiZoomLevel = useUiZoomLevel()
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
    if (!date) return 'Never'
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(date)
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
        <SettingsLayout categories={APP_PREF_CATEGORIES} searchIndex={APP_PREF_SEARCH_INDEX}>
          {/* Terminal Appearance Section */}
          <SettingsSection id="appearance">
            <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
              <div className="w-full pt-1 md:w-1/3">
                <h2 className="text-lg font-medium text-foreground">Terminal Appearance</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Customize the look and feel of your terminal.
                </p>
              </div>
              <div className="w-full space-y-4 md:w-full md:w-2/3">
                {/* UI Zoom Level (whole interface) */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-medium text-secondary-foreground">
                      UI Zoom Level
                    </label>
                    <button
                      type="button"
                      onClick={handleUiZoomReset}
                      className="text-xs text-primary hover:underline disabled:opacity-50"
                      disabled={uiZoomLevel === UI_ZOOM_DEFAULT}
                    >
                      Reset to 100%
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
                    Zoom the entire interface (50–300%). Also adjustable with Ctrl+=, Ctrl+-,
                    Ctrl+0.
                  </p>
                </div>

                {/* Font Family */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Font Family
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
                    Choose a monospace font for terminal text.
                  </p>
                </div>

                {/* Font Size */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Font Size: {fontSize}px
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
                    Adjust terminal text size (10-24px).
                  </p>
                </div>

                {/* Buffer Size */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Scrollback Buffer Size
                  </label>
                  <select
                    value={bufferSize}
                    onChange={(e) => handleBufferSizeChange(parseInt(e.target.value, 10))}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                  >
                    {BUFFER_SIZE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Number of lines to keep in terminal history. Higher values use more memory.
                    Changes apply to new terminals.
                  </p>
                </div>

                {/* Max Terminals */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Max Terminals Per Project
                  </label>
                  <select
                    value={maxTerminals}
                    onChange={(e) => handleMaxTerminalsChange(parseInt(e.target.value, 10))}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                  >
                    {MAX_TERMINALS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Maximum number of terminal tabs allowed per project.
                  </p>
                </div>

                {/* Terminal Renderer */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Terminal Renderer
                  </label>
                  <select
                    value={terminalRenderer}
                    onChange={(e) => handleRendererChange(e.target.value)}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                  >
                    {TERMINAL_RENDERER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    GPU-accelerated rendering for terminal output. WebGL provides best performance.
                    Changes apply to new terminals.
                  </p>
                </div>

                {/* Preview */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Preview
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
            <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
              <div className="w-full pt-1 md:w-1/3">
                <h2 className="text-lg font-medium text-foreground">Default Shell</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Set the default shell for new terminals.
                </p>
              </div>
              <div className="w-full space-y-4 md:w-full md:w-2/3">
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Shell
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
                    <option value="">System Default</option>
                    {availableShells?.available?.map((shell) => (
                      <option key={shell.path} value={shell.path}>
                        {shell.displayName}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    This can be overridden per-project in project settings.
                  </p>
                </div>
              </div>
            </div>
          </SettingsSection>

          {/* Terminal Behavior Section */}
          <SettingsSection id="behavior">
            <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
              <div className="w-full pt-1 md:w-1/3">
                <h2 className="text-lg font-medium text-foreground">Behavior</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Configure terminal cleanup and editor auto-save behavior.
                </p>
              </div>
              <div className="w-full space-y-4 md:w-full md:w-2/3">
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Open Terminal Links In
                  </label>
                  <select
                    value={terminalUrlOpenMode}
                    onChange={(e) => handleTerminalUrlOpenModeChange(e.target.value)}
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                  >
                    {TERMINAL_URL_OPEN_MODE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Choose whether Ctrl/Cmd+Click URLs from terminal output open in your system
                    browser or a new Termul browser tab.
                  </p>
                </div>

                {/* Orphan Detection Toggle */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Orphan Detection
                  </label>
                  <div className="flex items-center justify-between bg-secondary/30 border border-border rounded-md px-4 py-3">
                    <div className="flex-1">
                      <div className="text-sm text-foreground">Enable orphan detection</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Automatically clean up terminals that have been inactive
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
                    Timeout Before Cleanup
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
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Terminals inactive for this duration will be cleaned up (only if not displayed).
                  </p>
                </div>

                {/* Editor Auto Save Toggle (GH-539) */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Editor Auto Save
                  </label>
                  <div className="flex items-center justify-between bg-secondary/30 border border-border rounded-md px-4 py-3">
                    <div className="flex-1">
                      <div className="text-sm text-foreground">Enable auto save</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Automatically save editor files after you stop typing
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={editorAutoSave}
                      aria-label="Enable auto save"
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
                    Auto Save Delay
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
                    aria-label="Auto save delay"
                    className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {EDITOR_AUTO_SAVE_DELAY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Time to wait after your last edit before saving automatically.
                  </p>
                </div>
              </div>
            </div>
          </SettingsSection>

          {/* New Project Defaults Section */}
          <SettingsSection id="project-defaults">
            <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
              <div className="w-full pt-1 md:w-1/3">
                <h2 className="text-lg font-medium text-foreground">New Project Defaults</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Set default options for new projects.
                </p>
              </div>
              <div className="w-full space-y-4 md:w-full md:w-2/3">
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Default Color
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
                          title={color.charAt(0).toUpperCase() + color.slice(1)}
                        />
                      )
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    New projects will use this color by default.
                  </p>
                </div>
              </div>
            </div>
          </SettingsSection>

          {/* AI Agents Section */}
          <SettingsSection id="ai-agents">
            <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
              <div className="w-full pt-1 md:w-1/3">
                <div className="flex items-center gap-2">
                  <Bot size={18} className="text-primary" />
                  <h2 className="text-lg font-medium text-foreground">AI Agents</h2>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  View ACP agent availability and warm/auth status. Agent Chat supports these agents
                  automatically.
                </p>
              </div>
              <div className="w-full space-y-4 md:w-full md:w-2/3">
                <AcpAgentsSettings />
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Turn Timeout (hard cap)
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
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Maximum wall-clock duration for a single agent turn. Active turns that stream
                    continuously run until this cap; a silent (wedged) turn errors per the Turn Idle
                    Timeout below. The TERMUL_ACP_TURN_TIMEOUT_SECS env var still overrides this
                    (operator/diagnostic). Desktop only — the standalone server uses the env var.
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="acp-turn-idle-timeout"
                    className="block text-sm font-medium text-secondary-foreground mb-2"
                  >
                    Turn Idle Timeout
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
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Window with no agent activity after which a turn is treated as wedged and
                    cancelled. The TERMUL_ACP_TURN_IDLE_TIMEOUT_SECS env var still overrides this
                    (operator/diagnostic). Desktop only — the standalone server uses the env var.
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="acp-session-new-timeout"
                    className="block text-sm font-medium text-secondary-foreground mb-2"
                  >
                    Session/New Timeout
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
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    How long to wait for an agent to answer session/new before the spawn fails
                    (cold-start model fetches may need more). The
                    TERMUL_ACP_SESSION_NEW_TIMEOUT_SECS env var still overrides this
                    (operator/diagnostic). Desktop only — the standalone server uses the env var.
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="acp-session-reopen-timeout"
                    className="block text-sm font-medium text-secondary-foreground mb-2"
                  >
                    Session Reopen Timeout
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
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    How long to wait for session/load / session/resume (large histories replay
                    before responding; they may need more). The
                    TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS env var still overrides this
                    (operator/diagnostic). Desktop only — the standalone server uses the env var.
                  </p>
                </div>
                <div>
                  <label
                    htmlFor="acp-first-prompt-warmup"
                    className="block text-sm font-medium text-secondary-foreground mb-2"
                  >
                    First-Prompt Warmup Timeout
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
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Warmup prompt budget after session/new to absorb agent cold-start stalls; choose
                    Disabled to skip the warmup entirely. The TERMUL_ACP_FIRST_PROMPT_WARMUP_SECS
                    env var still overrides this (operator/diagnostic). Desktop only — the
                    standalone server uses the env var.
                  </p>
                </div>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection id="mcp-servers">
            <div className="flex flex-col gap-6 border-b border-border pb-6 md:flex-row md:items-start">
              <div className="w-full pt-1 md:w-1/3">
                <div className="flex items-center gap-2">
                  <Network size={18} className="text-primary" />
                  <h2 className="text-lg font-medium text-foreground">MCP Servers</h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Configure global MCP servers for capability-aware injection into new chats.
                </p>
              </div>
              <div className="w-full md:w-2/3">
                <McpServersSettings />
              </div>
            </div>
          </SettingsSection>

          {/* Keyboard Shortcuts Section */}
          <SettingsSection id="shortcuts">
            <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
              <div className="w-full pt-1 md:w-1/3">
                <div className="flex items-center gap-2">
                  <Keyboard size={18} className="text-primary" />
                  <h2 className="text-lg font-medium text-foreground">Keyboard Shortcuts</h2>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Customize keyboard shortcuts to match your workflow.
                </p>
                <button
                  onClick={() => setIsResetShortcutsDialogOpen(true)}
                  className="mt-4 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RotateCcw size={12} />
                  Reset all shortcuts
                </button>
              </div>
              <div className="w-full space-y-4 md:w-full md:w-2/3">
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
            <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
              <div className="w-full pt-1 md:w-1/3">
                <div className="flex items-center gap-2">
                  <Download size={18} className="text-primary" />
                  <h2 className="text-lg font-medium text-foreground">Updates</h2>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Manage application updates and version information.
                </p>
              </div>
              <div className="w-full space-y-4 md:w-full md:w-2/3">
                {/* Current Version */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Current Version
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
                      Release Channel
                    </label>
                    <div className="space-y-2">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {(
                          [
                            {
                              id: 'stable',
                              label: 'Stable',
                              description: 'Production releases. Most reliable.'
                            },
                            {
                              id: 'insider',
                              label: 'Insider',
                              description: 'Release candidates (rc) before stable.'
                            },
                            {
                              id: 'nightly',
                              label: 'Nightly',
                              description: 'Automated main-branch builds.'
                            }
                          ] as const
                        ).map((option) => {
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
                                {option.label}
                              </span>
                              <span className="text-3xs text-muted-foreground font-normal">
                                {option.description}
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
                              ? 'Nightly builds are automated from the latest commit and may be unstable. Updates are offered as a manual download from the nightly release page.'
                              : 'Insider release candidates may be unfinished. Updates are offered as a manual download from the insider release page.'}
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
                      Update Available
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
                          Version {version} is available!
                        </div>
                        <div className="text-xs text-muted-foreground mt-0.5">
                          {isAurUpdater
                            ? 'Update through AUR with: yay -S termul-manager'
                            : isManualUpdateMode
                              ? 'Automatic update is unavailable. Please download and install the latest version manually.'
                              : 'A new version is ready to download.'}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Update Error */}
                {updateError && (
                  <div>
                    <label className="block text-sm font-medium text-secondary-foreground mb-2">
                      Update Error
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
                    Check for Updates
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={checkForUpdates}
                      disabled={isChecking}
                      className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 disabled:bg-primary/50 disabled:cursor-not-allowed border border-primary rounded-lg text-sm text-primary-foreground transition-colors"
                    >
                      <Download size={16} />
                      {isChecking ? 'Checking for updates...' : 'Check for Updates'}
                    </button>
                    {updateAvailable && isManualUpdateMode && (
                      <button
                        onClick={installAndRestart}
                        className="flex items-center gap-2 px-4 py-2 bg-amber-500 hover:bg-amber-500/90 border border-amber-500 rounded-lg text-sm text-white transition-colors"
                      >
                        <ExternalLink size={16} />
                        Open Download Page
                      </button>
                    )}
                  </div>
                  {lastChecked && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Last checked: {formatLastChecked(lastChecked)}
                    </p>
                  )}
                </div>

                {/* Auto-update Toggle */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Auto-update
                  </label>
                  <div className="flex items-center justify-between bg-secondary/30 border border-border rounded-md px-4 py-3">
                    <div className="flex-1">
                      <div className="text-sm text-foreground">Automatically check for updates</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        When enabled, the app will periodically check for new versions
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
                      Skipped Version
                    </label>
                    <div className="bg-secondary/30 border border-border rounded-md px-4 py-3">
                      <div className="text-sm text-foreground">
                        You are currently skipping version{' '}
                        <span className="font-mono">{skippedVersion}</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        This version will not be offered again until a newer version is available.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </SettingsSection>

          <SettingsSection id="diagnostics">
            <div className="flex flex-col items-start gap-6 border-b border-border pb-6 md:flex-row">
              <div className="w-full pt-1 md:w-1/3">
                <div className="flex items-center gap-2">
                  <FileText size={18} className="text-primary" />
                  <h2 className="text-lg font-medium text-foreground">Diagnostics & Logs</h2>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Export or copy application logs to troubleshoot issues.
                </p>
              </div>
              <div className="w-full space-y-4 md:w-full md:w-2/3">
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => void logApi.revealLogDir()}
                    className="flex items-center justify-start gap-2.5 px-4 py-3 bg-secondary/30 hover:bg-secondary/60 border border-border rounded-lg text-sm font-medium text-foreground transition-all hover:scale-[1.01] active:scale-[0.99] shadow-sm"
                  >
                    <FolderOpen size={16} className="text-muted-foreground" />
                    <div className="text-left">
                      <div>Reveal Log Folder</div>
                      <div className="text-3xs text-muted-foreground font-normal">
                        Open in file explorer
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
                      <div>Export Log File...</div>
                      <div className="text-3xs text-muted-foreground font-normal">
                        Save to a custom location
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
                      <div>Copy Log Contents</div>
                      <div className="text-3xs text-muted-foreground font-normal">
                        Copy logs to clipboard
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
                      <div>Export to Default Directory</div>
                      <div className="text-3xs text-muted-foreground font-normal">
                        Save directly to Downloads
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          </SettingsSection>

          {/* Reset Section */}
          <SettingsSection id="reset">
            <div className="flex flex-col items-start gap-6 pb-6 md:flex-row">
              <div className="w-full pt-1 md:w-1/3">
                <h2 className="text-lg font-medium text-foreground">Reset Settings</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Restore all settings to their default values.
                </p>
              </div>
              <div className="w-full md:w-2/3">
                <button
                  onClick={() => setIsResetDialogOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-card hover:bg-secondary border border-border rounded-lg text-sm text-foreground transition-colors"
                >
                  <RotateCcw size={16} />
                  Reset to Defaults
                </button>
              </div>
            </div>
          </SettingsSection>
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
