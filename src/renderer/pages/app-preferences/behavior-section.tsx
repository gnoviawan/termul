import { SettingsSection } from '@/components/settings/SettingsLayout'
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

function NotifySwitch({
  label,
  description,
  checked,
  onToggle
}: {
  label: string
  description: string
  checked: boolean
  onToggle: (enabled: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between bg-secondary/30 border border-border rounded-md px-4 py-3">
      <div className="flex-1">
        <div className="text-sm text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onToggle(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
          checked ? 'bg-primary-fill' : 'bg-input'
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-primary-foreground transition-transform',
            checked ? 'translate-x-6' : 'translate-x-1'
          )}
        />
      </button>
    </div>
  )
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
      <div className="grid grid-cols-1 items-start gap-6 border-b border-border pb-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="w-full pt-1">
          <h2 className="text-lg font-medium text-foreground">Behavior</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Configure terminal cleanup and editor auto-save behavior.
          </p>
        </div>
        <div className="w-full space-y-4">
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
              Choose whether Ctrl/Cmd+Click URLs from terminal output open in your system browser or
              a new Termul browser tab.
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
                  orphanDetectionEnabled ? 'bg-primary-fill' : 'bg-input'
                )}
              >
                <span
                  className={cn(
                    'inline-block h-4 w-4 transform rounded-full bg-primary-foreground transition-transform',
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
                handleOrphanTimeoutChange(e.target.value ? parseInt(e.target.value, 10) : null)
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
                  editorAutoSave ? 'bg-primary-fill' : 'bg-input'
                )}
              >
                <span
                  className={cn(
                    'inline-block h-4 w-4 transform rounded-full bg-primary-foreground transition-transform',
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

          <div>
            <div className="block text-sm font-medium text-secondary-foreground mb-2">
              Notifications
            </div>
            <div className="space-y-3">
              <NotifySwitch
                label="Notify when a terminal agent finishes"
                description="Ping when a long-running terminal tab goes quiet."
                checked={notifyOnTerminalIdle}
                onToggle={handleNotifyOnTerminalIdleToggle}
              />
              <NotifySwitch
                label="Notify when an agent chat turn finishes"
                description="Ping when an Agent Chat turn ends and nothing is queued."
                checked={notifyOnAgentChatTurnFinished}
                onToggle={handleNotifyOnAgentChatTurnFinishedToggle}
              />
              <NotifySwitch
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
