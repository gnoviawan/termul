import { useEffect, useMemo, useRef } from 'react'
import type { ToolCall } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import type { ChatMessage } from '@/stores/acp-store/types'
import {
  countSubagents,
  lastUserBoundary,
  runningBackgroundSubagents,
  type SubagentCounts,
  type SubagentStatus,
  selectCurrentTurnSubagents,
  subagentParentTurn,
  subagentStatus,
  withRunningBackground
} from './subagent-strip'

export interface CurrentTurnSubagents {
  /** The current turn's subagents, then older-turn ones still running in the background. */
  subagents: ToolCall[]
  /** Rows from older turns, appended after the current turn's. */
  earlier: number
  /** Background subagents still running, from any turn. */
  backgroundRunning: number
  /** Status per row, in row order. */
  statuses: SubagentStatus[]
  counts: SubagentCounts
}

/** The pill's subagents and their statuses. */
export function useCurrentTurnSubagents(
  toolCalls: readonly ToolCall[],
  messages: readonly ChatMessage[],
  turnActive: boolean
): CurrentTurnSubagents {
  const lastUser = lastUserBoundary(messages)
  const lastUserSeq = lastUser?.seq
  const lastUserTimestamp = lastUser?.timestamp
  const hasUser = lastUser !== null
  const current = useMemo(
    () =>
      selectCurrentTurnSubagents(
        toolCalls,
        hasUser ? { seq: lastUserSeq, timestamp: lastUserTimestamp } : null
      ),
    [toolCalls, hasUser, lastUserSeq, lastUserTimestamp]
  )
  const background = useMemo(
    () => runningBackgroundSubagents(toolCalls, messages),
    [toolCalls, messages]
  )
  const subagents = useMemo(() => withRunningBackground(current, background), [current, background])
  const statuses = useMemo(
    () =>
      subagents.map((tc) =>
        subagentStatus(
          tc,
          subagentParentTurn(
            tc,
            hasUser ? { seq: lastUserSeq, timestamp: lastUserTimestamp } : null,
            turnActive
          )
        )
      ),
    [subagents, hasUser, lastUserSeq, lastUserTimestamp, turnActive]
  )
  const counts = countSubagents(statuses)

  return {
    subagents,
    earlier: subagents.length - current.length,
    backgroundRunning: background.length,
    statuses,
    counts
  }
}

/**
 * Background subagents the chat waits on after its turn ended (0 while the
 * turn runs). Logs when the chat starts and stops waiting.
 */
export function useBackgroundWait(
  sessionId: string,
  backgroundRunning: number,
  turnActive: boolean
): number {
  const waiting = turnActive ? 0 : backgroundRunning
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
