import { useEffect, useMemo, useRef, useState } from 'react'
import type { ToolCall } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import type { ChatMessage } from '@/stores/acp-store/types'
import {
  countSubagents,
  lastUserBoundary,
  runningBackgroundSubagents,
  type SubagentCounts,
  selectCurrentTurnSubagents,
  subagentStatus
} from './subagent-strip'

export interface CurrentTurnSubagents {
  subagents: ToolCall[]
  counts: SubagentCounts
  /** Settle time per subagent id, stamped on an observed running -> settled transition. */
  endedAt: Readonly<Record<string, number>>
}

/** The current turn's subagents, their status counts and their settle times. */
export function useCurrentTurnSubagents(
  toolCalls: readonly ToolCall[],
  messages: readonly ChatMessage[],
  turnActive: boolean
): CurrentTurnSubagents {
  const lastUser = lastUserBoundary(messages)
  const lastUserSeq = lastUser?.seq
  const lastUserTimestamp = lastUser?.timestamp
  const hasUser = lastUser !== null
  const subagents = useMemo(
    () =>
      selectCurrentTurnSubagents(
        toolCalls,
        hasUser ? { seq: lastUserSeq, timestamp: lastUserTimestamp } : null
      ),
    [toolCalls, hasUser, lastUserSeq, lastUserTimestamp]
  )
  const counts = countSubagents(subagents, turnActive)

  // Settle time is stamped only on an observed running -> settled transition,
  // so history-loaded rows never show a bogus duration.
  const [endedAt, setEndedAt] = useState<Record<string, number>>({})
  const prevRunning = useRef(new Map<string, boolean>())
  useEffect(() => {
    const settled: string[] = []
    for (const tc of subagents) {
      const running = subagentStatus(tc, turnActive) === 'running'
      if (prevRunning.current.get(tc.toolCallId) === true && !running) settled.push(tc.toolCallId)
      prevRunning.current.set(tc.toolCallId, running)
    }
    if (settled.length === 0) return
    const stamp = Date.now()
    setEndedAt((prev) => {
      const next = { ...prev }
      for (const id of settled) next[id] ??= stamp
      return next
    })
  }, [subagents, turnActive])

  return { subagents, counts, endedAt }
}

/**
 * Background subagents the chat waits on after its turn ended (0 while the
 * turn runs). Logs when the chat starts and stops waiting.
 */
export function useBackgroundWait(
  sessionId: string,
  toolCalls: readonly ToolCall[],
  messages: readonly ChatMessage[],
  turnActive: boolean
): number {
  const running = useMemo(
    () => runningBackgroundSubagents(toolCalls, messages).length,
    [toolCalls, messages]
  )
  const waiting = turnActive ? 0 : running
  const wasWaiting = useRef(false)
  useEffect(() => {
    const isWaiting = waiting > 0
    if (isWaiting === wasWaiting.current) return
    wasWaiting.current = isWaiting
    void logFrontendError({
      level: 'info',
      source: 'chat.backgroundSubagents',
      message:
        waiting > 0
          ? `Chat ${sessionId} waits on ${waiting} background subagent${waiting === 1 ? '' : 's'} after its turn ended`
          : `Chat ${sessionId} no longer waits on background subagents`
    })
  }, [sessionId, waiting])
  return waiting
}
