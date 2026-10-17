import { useEffect, useState } from 'react'
import { Bot } from '@/components/icons'
import { AcpAgentsSettings } from '@/components/settings/AcpAgentsSettings'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { PANEL_FIELD_CLASS } from '@/components/ui/panel-styles'
import type { AgentIdleWindowStatus } from '@/lib/acp-api'
import { acpApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import {
  ACP_SESSION_NEW_TIMEOUT_OPTIONS,
  ACP_SESSION_REOPEN_TIMEOUT_OPTIONS,
  ACP_TURN_IDLE_TIMEOUT_OPTIONS,
  ACP_TURN_TIMEOUT_OPTIONS,
  AGENT_IDLE_WINDOW_OPTIONS,
  formatAgentIdleWindow
} from '@/types/settings'

interface AiAgentsSectionProps {
  acpTurnTimeoutSecs: number | null
  acpTurnIdleTimeoutSecs: number | null
  acpSessionNewTimeoutSecs: number | null
  acpSessionReopenTimeoutSecs: number | null
  agentIdleWindowSecs: number | null
  handleAcpTurnTimeoutChange: (value: number | null) => void
  handleAcpTurnIdleTimeoutChange: (value: number | null) => void
  handleAcpSessionNewTimeoutChange: (value: number | null) => void
  handleAcpSessionReopenTimeoutChange: (value: number | null) => void
  handleAgentIdleWindowChange: (value: number | null) => void
}

interface TimeoutChoice {
  value: number | null
  label: string
}

function formatLimit(secs: number | null, fallback: string): string {
  if (secs === null) return fallback
  return formatAgentIdleWindow(secs)
}

function TimeoutSelect({
  id,
  label,
  value,
  options,
  help,
  onChange
}: {
  id: string
  label: string
  value: number | null
  options: TimeoutChoice[]
  help: string
  onChange: (value: number | null) => void
}): React.JSX.Element {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-secondary-foreground mb-2">
        {label}
      </label>
      <select
        id={id}
        value={value === null ? 'null' : String(value)}
        onChange={(e) => onChange(e.target.value === 'null' ? null : parseInt(e.target.value, 10))}
        className={cn(PANEL_FIELD_CLASS, 'w-full px-3 py-2 text-sm')}
      >
        {options.map((option) => (
          <option
            key={option.value === null ? 'null' : String(option.value)}
            value={option.value === null ? 'null' : String(option.value)}
          >
            {option.label}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground mt-1">{help}</p>
    </div>
  )
}

export function AiAgentsSection({
  acpTurnTimeoutSecs,
  acpTurnIdleTimeoutSecs,
  acpSessionNewTimeoutSecs,
  acpSessionReopenTimeoutSecs,
  agentIdleWindowSecs,
  handleAcpTurnTimeoutChange,
  handleAcpTurnIdleTimeoutChange,
  handleAcpSessionNewTimeoutChange,
  handleAcpSessionReopenTimeoutChange,
  handleAgentIdleWindowChange
}: AiAgentsSectionProps): React.JSX.Element {
  const isDesktop = isTauriContext()
  const [liveWindow, setLiveWindow] = useState<AgentIdleWindowStatus | null>(null)
  const [liveWindowFailed, setLiveWindowFailed] = useState(false)

  useEffect(() => {
    // `agentIdleWindowSecs` is the refetch key. The host answer can differ
    // from the saved value when TERMUL_AGENT_IDLE_REAP_SECS is set.
    let cancelled = false
    void agentIdleWindowSecs
    void acpApi
      .getAgentIdleWindow()
      .then((status) => {
        if (cancelled) return
        setLiveWindow(status)
        setLiveWindowFailed(false)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setLiveWindow(null)
        setLiveWindowFailed(true)
        void logFrontendError({
          level: 'warn',
          source: 'AiAgentsSection.idleWindow',
          message: `Failed to read the agent idle window: ${error instanceof Error ? error.message : String(error)}`
        })
      })
    return () => {
      cancelled = true
    }
  }, [agentIdleWindowSecs])

  const envLocksWindow = liveWindow?.source === 'env'
  const operatorLocksWindow = liveWindow?.source === 'operator'

  return (
    <SettingsSection id="ai-agents">
      <div className="space-y-4 border-b border-border pb-6">
        <div className="w-full space-y-4">
          <AcpAgentsSettings
            header={
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Bot size={18} className="text-primary" />
                  <h2 className="text-lg font-medium text-foreground">AI Agents</h2>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">See which agents are ready.</p>
              </div>
            }
          />
          <TimeoutSelect
            id="agent-idle-window"
            label="Close idle chats after"
            value={agentIdleWindowSecs === 1800 ? null : agentIdleWindowSecs}
            options={AGENT_IDLE_WINDOW_OPTIONS}
            onChange={handleAgentIdleWindowChange}
            help="A chat closes after you leave it this long. A running answer or a waiting question keeps it open."
          />
          {(envLocksWindow || operatorLocksWindow) && liveWindow ? (
            <p className="text-xs text-muted-foreground">
              Using {formatAgentIdleWindow(liveWindow.secs)} from server setup. This menu applies
              after a restart without that setup.
            </p>
          ) : null}
          {liveWindowFailed ? (
            <p className="text-xs text-muted-foreground">
              Could not read the current time. Your choice is still saved.
            </p>
          ) : null}
          {isDesktop ? (
            <>
              <TimeoutSelect
                id="acp-turn-idle-timeout"
                label="If an answer goes quiet"
                value={acpTurnIdleTimeoutSecs}
                options={ACP_TURN_IDLE_TIMEOUT_OPTIONS}
                onChange={handleAcpTurnIdleTimeoutChange}
                help="Cancel the answer after this long with no update."
              />
              <TimeoutSelect
                id="acp-turn-timeout"
                label="Longest one answer"
                value={acpTurnTimeoutSecs}
                options={ACP_TURN_TIMEOUT_OPTIONS}
                onChange={handleAcpTurnTimeoutChange}
                help="Stop an answer that is still writing."
              />
              <TimeoutSelect
                id="acp-session-new-timeout"
                label="Start a new chat"
                value={acpSessionNewTimeoutSecs === 60 ? null : acpSessionNewTimeoutSecs}
                options={ACP_SESSION_NEW_TIMEOUT_OPTIONS}
                onChange={handleAcpSessionNewTimeoutChange}
                help="How long to wait for the agent to start."
              />
              <TimeoutSelect
                id="acp-session-reopen-timeout"
                label="Open a saved chat"
                value={acpSessionReopenTimeoutSecs === 60 ? null : acpSessionReopenTimeoutSecs}
                options={ACP_SESSION_REOPEN_TIMEOUT_OPTIONS}
                onChange={handleAcpSessionReopenTimeoutChange}
                help="How long to wait. A long chat can need more time."
              />
            </>
          ) : (
            <div className="bg-secondary/30 border border-border rounded-md px-4 py-3 text-xs text-muted-foreground">
              <p className="text-sm font-medium text-foreground">While an answer is running</p>
              <p className="mt-1">Goes quiet: {formatLimit(acpTurnIdleTimeoutSecs, 'No limit')}</p>
              <p>Still writing: {formatLimit(acpTurnTimeoutSecs, 'No limit')}</p>
              <p className="mt-3 text-sm font-medium text-foreground">Starting a chat</p>
              <p className="mt-1">New chat: {formatLimit(acpSessionNewTimeoutSecs, '1 minute')}</p>
              <p>Saved chat: {formatLimit(acpSessionReopenTimeoutSecs, '1 minute')}</p>
              <p className="mt-2">Set on the server.</p>
            </div>
          )}
        </div>
      </div>
    </SettingsSection>
  )
}
