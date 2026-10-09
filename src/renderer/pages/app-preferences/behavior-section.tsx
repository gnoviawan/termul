import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsSwitchRow } from '@/components/settings/SettingsSwitchRow'
import { PANEL_FIELD_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import {
  DEFAULT_APP_SETTINGS,
  EDITOR_AUTO_SAVE_DELAY_OPTIONS,
  ORPHAN_TIMEOUT_OPTIONS,
  TERMINAL_URL_OPEN_MODE_OPTIONS,
  type TerminalUrlOpenMode
} from '@/types/settings'

interface BehaviorSectionProps {
  terminalUrlOpenMode: TerminalUrlOpenMode
  orphanDetectionEnabled: boolean
  orphanDetectionTimeout: number | null
  editorAutoSave: boolean
  editorAutoSaveDelayMs: number
  notifyOnTerminalIdle: boolean
  notifyOnAgentChatTurnFinished: boolean
  notifyOnAgentChatNeedsYou: boolean
  handleTerminalUrlOpenModeChange: (value: string) => void
  handleOrphanDetectionToggle: (enabled: boolean) => void
  handleOrphanTimeoutChange: (value: number | null) => void
  handleEditorAutoSaveToggle: (enabled: boolean) => void
  handleEditorAutoSaveDelayChange: (value: number) => void
  handleNotifyOnTerminalIdleToggle: (enabled: boolean) => void
  handleNotifyOnAgentChatTurnFinishedToggle: (enabled: boolean) => void
  handleNotifyOnAgentChatNeedsYouToggle: (enabled: boolean) => void
}

export function BehaviorSection({
  terminalUrlOpenMode,
  orphanDetectionEnabled,
  orphanDetectionTimeout,
  editorAutoSave,
  editorAutoSaveDelayMs,
  notifyOnTerminalIdle,
  notifyOnAgentChatTurnFinished,
  notifyOnAgentChatNeedsYou,
  handleTerminalUrlOpenModeChange,
  handleOrphanDetectionToggle,
  handleOrphanTimeoutChange,
  handleEditorAutoSaveToggle,
  handleEditorAutoSaveDelayChange,
  handleNotifyOnTerminalIdleToggle,
  handleNotifyOnAgentChatTurnFinishedToggle,
  handleNotifyOnAgentChatNeedsYouToggle
}: BehaviorSectionProps): React.JSX.Element {
  return (
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
              className={cn(PANEL_FIELD_CLASS, 'w-full px-3 py-2 text-sm')}
            >
              {TERMINAL_URL_OPEN_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              Choose whether Ctrl/Cmd+Click URLs from terminal output open in your system browser or
              a new Termul browser tab.
            </p>
          </div>

          {/* Orphan Detection Toggle */}
          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Orphan Detection
            </label>
            <SettingsSwitchRow
              label="Enable orphan detection"
              description="Automatically clean up terminals that have been inactive"
              checked={orphanDetectionEnabled}
              onToggle={handleOrphanDetectionToggle}
            />
          </div>

          {/* Timeout Dropdown */}
          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Timeout Before Cleanup
            </label>
            <select
              value={orphanDetectionTimeout ?? 600000}
              onChange={(e) =>
                handleOrphanTimeoutChange(e.target.value ? parseInt(e.target.value, 10) : null)
              }
              disabled={!orphanDetectionEnabled}
              className={cn(
                PANEL_FIELD_CLASS,
                'w-full px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50'
              )}
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
            <SettingsSwitchRow
              label="Enable auto save"
              description="Automatically save editor files after you stop typing"
              checked={editorAutoSave}
              onToggle={handleEditorAutoSaveToggle}
            />
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
              className={cn(
                PANEL_FIELD_CLASS,
                'w-full px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50'
              )}
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

          <div>
            <div className="block text-sm font-medium text-secondary-foreground mb-2">
              Notifications
            </div>
            <div className="space-y-3">
              <SettingsSwitchRow
                label="Notify when a terminal agent finishes"
                description="Ping when a long-running terminal tab goes quiet."
                checked={notifyOnTerminalIdle}
                onToggle={handleNotifyOnTerminalIdleToggle}
              />
              <SettingsSwitchRow
                label="Notify when an agent chat turn finishes"
                description="Ping when an Agent Chat turn ends and nothing is queued."
                checked={notifyOnAgentChatTurnFinished}
                onToggle={handleNotifyOnAgentChatTurnFinishedToggle}
              />
              <SettingsSwitchRow
                label="Notify when an agent chat needs you"
                description="Ping when an Agent Chat waits for approval or an answer."
                checked={notifyOnAgentChatNeedsYou}
                onToggle={handleNotifyOnAgentChatNeedsYouToggle}
              />
            </div>
          </div>
        </div>
      </div>
    </SettingsSection>
  )
}
