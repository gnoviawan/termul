import { Bot } from '@/components/icons'
import { AcpAgentsSettings } from '@/components/settings/AcpAgentsSettings'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { PANEL_FIELD_CLASS } from '@/components/ui/panel-styles'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import {
  ACP_SESSION_NEW_TIMEOUT_OPTIONS,
  ACP_SESSION_REOPEN_TIMEOUT_OPTIONS,
  ACP_TURN_IDLE_TIMEOUT_OPTIONS,
  ACP_TURN_TIMEOUT_OPTIONS
} from '@/types/settings'

interface AiAgentsSectionProps {
  acpTurnTimeoutSecs: number | null
  acpTurnIdleTimeoutSecs: number | null
  acpSessionNewTimeoutSecs: number | null
  acpSessionReopenTimeoutSecs: number | null
  handleAcpTurnTimeoutChange: (value: number | null) => void
  handleAcpTurnIdleTimeoutChange: (value: number | null) => void
  handleAcpSessionNewTimeoutChange: (value: number | null) => void
  handleAcpSessionReopenTimeoutChange: (value: number | null) => void
}

export function AiAgentsSection({
  acpTurnTimeoutSecs,
  acpTurnIdleTimeoutSecs,
  acpSessionNewTimeoutSecs,
  acpSessionReopenTimeoutSecs,
  handleAcpTurnTimeoutChange,
  handleAcpTurnIdleTimeoutChange,
  handleAcpSessionNewTimeoutChange,
  handleAcpSessionReopenTimeoutChange
}: AiAgentsSectionProps): React.JSX.Element {
  return (
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
          {isTauriContext() ? (
            <>
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
                  className={cn(PANEL_FIELD_CLASS, 'w-full px-3 py-2 text-sm')}
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
                  (operator/diagnostic).
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
                  value={acpTurnIdleTimeoutSecs === null ? 'null' : String(acpTurnIdleTimeoutSecs)}
                  onChange={(e) =>
                    handleAcpTurnIdleTimeoutChange(
                      e.target.value === 'null' ? null : parseInt(e.target.value, 10)
                    )
                  }
                  className={cn(PANEL_FIELD_CLASS, 'w-full px-3 py-2 text-sm')}
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
                  (operator/diagnostic).
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
                  className={cn(PANEL_FIELD_CLASS, 'w-full px-3 py-2 text-sm')}
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
                  (cold-start model fetches may need more). The TERMUL_ACP_SESSION_NEW_TIMEOUT_SECS
                  env var still overrides this (operator/diagnostic).
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
                  className={cn(PANEL_FIELD_CLASS, 'w-full px-3 py-2 text-sm')}
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
                  How long to wait for session/load / session/resume (large histories replay before
                  responding; they may need more). The TERMUL_ACP_SESSION_REOPEN_TIMEOUT_SECS env
                  var still overrides this (operator/diagnostic).
                </p>
              </div>
            </>
          ) : (
            // Web (#843): the ACP timeout budgets are enforced by the server
            // (env-var driven on the standalone server; the renderer-side
            // selects push desktop-only Tauri commands). Show the effective
            // values read-only when the store has them, plus a managed note.
            <div className="bg-secondary/30 border border-border rounded-md px-4 py-3">
              <div className="text-sm font-medium text-foreground">ACP timeouts</div>
              <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                <li>
                  Turn timeout (hard cap):{' '}
                  <span className="font-mono text-foreground">
                    {acpTurnTimeoutSecs === null ? 'server default' : `${acpTurnTimeoutSecs}s`}
                  </span>
                </li>
                <li>
                  Turn idle timeout:{' '}
                  <span className="font-mono text-foreground">
                    {acpTurnIdleTimeoutSecs === null
                      ? 'server default'
                      : `${acpTurnIdleTimeoutSecs}s`}
                  </span>
                </li>
                <li>
                  Session/new timeout:{' '}
                  <span className="font-mono text-foreground">
                    {acpSessionNewTimeoutSecs === null
                      ? 'server default'
                      : `${acpSessionNewTimeoutSecs}s`}
                  </span>
                </li>
                <li>
                  Session reopen timeout:{' '}
                  <span className="font-mono text-foreground">
                    {acpSessionReopenTimeoutSecs === null
                      ? 'server default'
                      : `${acpSessionReopenTimeoutSecs}s`}
                  </span>
                </li>
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Managed by the server — timeouts for agents spawned by the standalone server come
                from its env vars (TERMUL_ACP_*_TIMEOUT_SECS), not from the browser client. The
                values above reflect the effective budgets in this session.
              </p>
            </div>
          )}
        </div>
      </div>
    </SettingsSection>
  )
}
