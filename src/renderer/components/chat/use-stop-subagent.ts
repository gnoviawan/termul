import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { acpStopSubagent, type ToolCall } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import type { SubagentStatus } from './subagent-strip'
import { useSubagentSurface } from './subagent-surface-context'

/** A stop the agent never confirms frees the button again after this long. */
const STOP_CONFIRM_TIMEOUT_MS = 15_000

export interface SubagentStop {
  /** The agent lets Termul stop this subagent now. */
  canStop: boolean
  /** A stop was sent and the agent has not confirmed it yet. */
  stopping: boolean
  stop: () => void
}

/**
 * Stop one running subagent through the host. The agent confirms by ending
 * the subagent's record as cancelled, which moves `status` off `running`.
 */
export function useStopSubagent(toolCall: ToolCall, status: SubagentStatus): SubagentStop {
  const { agentId, sessionId } = useSubagentSurface()
  const record = toolCall.subagent
  const [stopping, setStopping] = useState(false)
  const canStop =
    status === 'running' && record?.caps.stop === 'session-cancel' && !!agentId && !!sessionId

  useEffect(() => {
    if (!stopping) return
    if (status !== 'running') {
      setStopping(false)
      return
    }
    const timer = setTimeout(() => setStopping(false), STOP_CONFIRM_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [stopping, status])

  const stop = useCallback(() => {
    if (!record || !agentId || !sessionId) return
    const subagent = `${record.id.slice(0, 128)} in chat ${sessionId}`
    setStopping(true)
    void logFrontendError({
      level: 'info',
      source: 'chat.subagentStop',
      message: `Stopping subagent ${subagent}`
    })
    acpStopSubagent(agentId, sessionId, record.id).then(
      (outcome) => {
        if (outcome === 'already_ended') setStopping(false)
      },
      (error: unknown) => {
        setStopping(false)
        const message = error instanceof Error ? error.message : String(error)
        toast.error("Couldn't stop the subagent", { description: message })
        void logFrontendError({
          level: 'warn',
          source: 'chat.subagentStop',
          message: `Stop of subagent ${subagent} failed: ${message}`
        })
      }
    )
  }, [record, agentId, sessionId])

  return { canStop, stopping, stop }
}
