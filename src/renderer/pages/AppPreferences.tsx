import { useState, useEffect } from 'react'
import { RotateCcw, Keyboard } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  useTerminalFontFamily,
  useTerminalFontSize,
  useTerminalBufferSize,
  useDefaultShell,
  useDefaultProjectColor,
  useMaxTerminalsPerProject
} from '@/stores/app-settings-store'
import { useProjects, useActiveProjectId, useProjectActions } from '@/stores/project-store'
import { useUpdateAppSetting, useResetAppSettings } from '@/hooks/use-app-settings'
import { FONT_FAMILY_OPTIONS, BUFFER_SIZE_OPTIONS, MAX_TERMINALS_OPTIONS } from '@/types/settings'
import type { ShellInfo } from '@shared/types/ipc.types'
import type { ProjectColor } from '@/types/project'
import { availableColors, getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ShortcutRecorder } from '@/components/ShortcutRecorder'
import { ProjectSidebar } from '@/components/ProjectSidebar'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import {
  useUpdateShortcut,
  useResetShortcut,
  useResetAllShortcuts
} from '@/hooks/use-keyboard-shortcuts'

export default function AppPreferences(): React.JSX.Element {
  const navigate = useNavigate()
  const fontFamily = useTerminalFontFamily()
  const fontSize = useTerminalFontSize()
  const bufferSize = useTerminalBufferSize()
  const defaultShell = useDefaultShell()
  const defaultProjectColor = useDefaultProjectColor() as ProjectColor
  const maxTerminals = useMaxTerminalsPerProject()

  // Project store hooks for ProjectSidebar
  const projects = useProjects()
  const activeProjectId = useActiveProjectId()
  const {
    selectProject,
    addProject,
    updateProject,
    deleteProject,
    archiveProject,
    restoreProject,
    reorderProjects
  } = useProjectActions()

  const updateSetting = useUpdateAppSetting()
  const resetSettings = useResetAppSettings()

  const [availableShells, setAvailableShells] = useState<ShellInfo[]>([])
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false)
  const [isResetShortcutsDialogOpen, setIsResetShortcutsDialogOpen] = useState(false)

  // Keyboard shortcuts
  const shortcuts = useKeyboardShortcutsStore((state) => state.shortcuts)
  const updateShortcut = useUpdateShortcut()
  const resetShortcut = useResetShortcut()
  const resetAllShortcuts = useResetAllShortcuts()

  // Load available shells
  useEffect(() => {
    async function loadShells(): Promise<void> {
      try {
        const result = await window.api.shell.getAvailableShells()
        if (result.success && result.data?.available) {
          setAvailableShells(result.data.available)
        }
      } catch {
        // Silently fail - user will see empty dropdown with System Default option
      }
    }
    loadShells()
  }, [])

  const handleFontFamilyChange = (value: string) => {
    updateSetting('terminalFontFamily', value)
  }

  const handleFontSizeChange = (value: number) => {
    updateSetting('terminalFontSize', value)
  }

  const handleBufferSizeChange = (value: number) => {
    updateSetting('terminalBufferSize', value)
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

  const handleResetConfirm = async () => {
    await resetSettings()
    await resetAllShortcuts()
    setIsResetDialogOpen(false)
  }

  const handleResetShortcutsConfirm = async () => {
    await resetAllShortcuts()
    setIsResetShortcutsDialogOpen(false)
  }

  return (
    <div className="h-screen flex overflow-hidden bg-background">
      <ProjectSidebar
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectProject={selectProject}
        onNewProject={() => navigate('/')}
        onUpdateProject={updateProject}
        onDeleteProject={deleteProject}
        onArchiveProject={archiveProject}
        onRestoreProject={restoreProject}
        onReorderProjects={reorderProjects}
      />

      <main className="flex-1 flex flex-col min-w-0 h-full relative">
        {/* Header */}
        <div className="h-16 flex items-center justify-between px-8 border-b border-border bg-card flex-shrink-0">
          <div>
            <h1 className="text-xl font-semibold text-foreground leading-tight">
              Application Preferences
            </h1>
            <p className="text-xs text-muted-foreground">
              Configure global application settings
            </p>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-8 pb-32">
          <div className="max-w-4xl mx-auto space-y-12">
          {/* Terminal Appearance Section */}
          <section>
            <div className="flex items-start gap-6 border-b border-border pb-8">
              <div className="w-1/3 pt-1">
                <h2 className="text-lg font-medium text-foreground">Terminal Appearance</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Customize the look and feel of your terminal.
                </p>
              </div>
              <div className="w-2/3 space-y-6">
                {/* Font Family */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Font Family
                  </label>
                  <select
                    value={fontFamily}
                    onChange={(e) => handleFontFamilyChange(e.target.value)}
                    className="w-full bg-secondary/50 border border-border rounded-md px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
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
                      onChange={(e) => handleFontSizeChange(parseInt(e.target.value))}
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
                    onChange={(e) => handleBufferSizeChange(parseInt(e.target.value))}
                    className="w-full bg-secondary/50 border border-border rounded-md px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                  >
                    {BUFFER_SIZE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Number of lines to keep in terminal history. Higher values use more memory. Changes apply to new terminals.
                  </p>
                </div>

                {/* Max Terminals */}
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Max Terminals Per Project
                  </label>
                  <select
                    value={maxTerminals}
                    onChange={(e) => handleMaxTerminalsChange(parseInt(e.target.value))}
                    className="w-full bg-secondary/50 border border-border rounded-md px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
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
                    <div>drwxr-xr-x  5 user staff 160 Jan 11 10:00 .</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Default Shell Section */}
          <section>
            <div className="flex items-start gap-6 border-b border-border pb-8">
              <div className="w-1/3 pt-1">
                <h2 className="text-lg font-medium text-foreground">Default Shell</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Set the default shell for new terminals.
                </p>
              </div>
              <div className="w-2/3 space-y-6">
                <div>
                  <label className="block text-sm font-medium text-secondary-foreground mb-2">
                    Shell
                  </label>
                  <select
                    value={defaultShell}
                    onChange={(e) => handleDefaultShellChange(e.target.value)}
                    className="w-full bg-secondary/50 border border-border rounded-md px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow"
                  >
                    <option value="">System Default</option>
                    {availableShells.map((shell) => (
                      <option key={shell.path} value={shell.name}>
                        {shell.name} ({shell.path})
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground mt-1">
                    This can be overridden per-project in project settings.
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* New Project Defaults Section */}
          <section>
            <div className="flex items-start gap-6 border-b border-border pb-8">
              <div className="w-1/3 pt-1">
                <h2 className="text-lg font-medium text-foreground">New Project Defaults</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Set default options for new projects.
                </p>
              </div>
              <div className="w-2/3 space-y-6">
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
          </section>

          {/* Keyboard Shortcuts Section */}
          <section>
            <div className="flex items-start gap-6 border-b border-border pb-8">
              <div className="w-1/3 pt-1">
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
          </section>

          {/* Reset Section */}
          <section>
            <div className="flex items-start gap-6 pb-8">
              <div className="w-1/3 pt-1">
                <h2 className="text-lg font-medium text-foreground">Reset Settings</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Restore all settings to their default values.
                </p>
              </div>
              <div className="w-2/3">
                <button
                  onClick={() => setIsResetDialogOpen(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-card hover:bg-secondary border border-border rounded-md text-sm text-foreground transition-colors"
                >
                  <RotateCcw size={16} />
                  Reset to Defaults
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
      </main>

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
    </div>
  )
}
