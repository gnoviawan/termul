import { useEffect, useState } from 'react'
import { AcpAgentsSettings } from '@/components/settings/AcpAgentsSettings'
import { rowId } from '@/components/settings/row-id'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { SettingsSection } from '@/components/settings/SettingsLayout'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { SettingsRow, settingsDescriptionId } from '@/components/settings/SettingsRow'
import { SettingsSelect } from '@/components/settings/SettingsSelect'
import type { AgentIdleWindowStatus } from '@/lib/acp-api'
import { acpApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { isTauriContext } from '@/lib/tauri-runtime'
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

const toOptions = (options: TimeoutChoice[]) =>
  options.map((option) => ({
    value: option.value === null ? 'none' : String(option.value),
    label: option.label
  }))

function TimeoutRow({
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
    <SettingsRow id={rowId(id)} htmlFor={id} label={label} description={help}>
      <SettingsSelect
        id={id}
        aria-describedby={settingsDescriptionId(id)}
        options={toOptions(options)}
        value={value === null ? 'none' : String(value)}
        onValueChange={(next) => onChange(next === 'none' ? null : Number.parseInt(next, 10))}
      />
    </SettingsRow>
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
      <SettingsGroup title="Chats">
        <SettingsCard>
          <TimeoutRow
            id="agent-idle-window"
            label="Close idle chats after"
            value={agentIdleWindowSecs === 1800 ? null : agentIdleWindowSecs}
            options={AGENT_IDLE_WINDOW_OPTIONS}
            onChange={handleAgentIdleWindowChange}
            help="A chat closes after you leave it this long. A running answer or a waiting question keeps it open."
          />
        </SettingsCard>
        {(envLocksWindow || operatorLocksWindow) && liveWindow ? (
          <SettingsNotice>
            Using {formatAgentIdleWindow(liveWindow.secs)} from server setup. This menu applies
            after a restart without that setup.
          </SettingsNotice>
        ) : null}
        {liveWindowFailed ? (
          <SettingsNotice>
            Could not read the current time. Your choice is still saved.
          </SettingsNotice>
        ) : null}
      </SettingsGroup>
      <SettingsGroup title="Time limits">
        {isDesktop ? (
          <SettingsCard>
            <TimeoutRow
              id="acp-turn-idle-timeout"
              label="If an answer goes quiet"
              value={acpTurnIdleTimeoutSecs}
              options={ACP_TURN_IDLE_TIMEOUT_OPTIONS}
              onChange={handleAcpTurnIdleTimeoutChange}
              help="Cancel the answer after this long with no update."
            />
            <TimeoutRow
              id="acp-turn-timeout"
              label="Longest one answer"
              value={acpTurnTimeoutSecs}
              options={ACP_TURN_TIMEOUT_OPTIONS}
              onChange={handleAcpTurnTimeoutChange}
              help="Stop an answer that is still writing."
            />
            <TimeoutRow
              id="acp-session-new-timeout"
              label="Start a new chat"
              value={acpSessionNewTimeoutSecs === 60 ? null : acpSessionNewTimeoutSecs}
              options={ACP_SESSION_NEW_TIMEOUT_OPTIONS}
              onChange={handleAcpSessionNewTimeoutChange}
              help="How long to wait for the agent to start."
            />
            <TimeoutRow
              id="acp-session-reopen-timeout"
              label="Open a saved chat"
              value={acpSessionReopenTimeoutSecs === 60 ? null : acpSessionReopenTimeoutSecs}
              options={ACP_SESSION_REOPEN_TIMEOUT_OPTIONS}
              onChange={handleAcpSessionReopenTimeoutChange}
              help="How long to wait. A long chat can need more time."
            />
          </SettingsCard>
        ) : (
          <SettingsCard>
            <SettingsRow
              label="While an answer is running"
              description={`Goes quiet: ${formatLimit(acpTurnIdleTimeoutSecs, 'No limit')} · Still writing: ${formatLimit(acpTurnTimeoutSecs, 'No limit')}`}
            />
            <SettingsRow
              label="Starting a chat"
              description={`New chat: ${formatLimit(acpSessionNewTimeoutSecs, '1 minute')} · Saved chat: ${formatLimit(acpSessionReopenTimeoutSecs, '1 minute')}`}
            />
          </SettingsCard>
        )}
        {!isDesktop && <p className="px-1 text-xs text-muted-foreground">Set on the server.</p>}
      </SettingsGroup>
      <AcpAgentsSettings />
    </SettingsSection>
  )
}
