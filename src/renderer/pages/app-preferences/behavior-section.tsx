import { SettingsSection } from '@/components/settings/SettingsLayout'
import { FIELD_FOCUS_CLASS, FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import {
  DEFAULT_APP_SETTINGS,
  EDITOR_AUTO_SAVE_DELAY_OPTIONS,
  TERMINAL_URL_OPEN_MODE_OPTIONS,
  type TerminalUrlOpenMode
} from '@/types/settings'

interface BehaviorSectionProps {
  terminalUrlOpenMode: TerminalUrlOpenMode
  editorAutoSave: boolean
  editorAutoSaveDelayMs: number
  notifyOnTerminalIdle: boolean
  notifyOnAgentChatTurnFinished: boolean
  notifyOnAgentChatNeedsYou: boolean
  handleTerminalUrlOpenModeChange: (value: string) => void
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
          `relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${FOCUS_RING_CLASS}`,
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
  editorAutoSave,
  editorAutoSaveDelayMs,
  notifyOnTerminalIdle,
  notifyOnAgentChatTurnFinished,
  notifyOnAgentChatNeedsYou,
  handleTerminalUrlOpenModeChange,
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
              className={`w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm pointer-coarse:text-base text-foreground transition-colors ${FIELD_FOCUS_CLASS}`}
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
                  `relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${FOCUS_RING_CLASS}`,
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
              className={`w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm pointer-coarse:text-base text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${FIELD_FOCUS_CLASS}`}
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
