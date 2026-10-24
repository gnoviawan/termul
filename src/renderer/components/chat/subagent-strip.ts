/**
 * Pure helpers for the top-right subagent pill: pick the current
 * turn's subagent calls and derive each row's status, title, tokens, and
 * duration. No React/store dependency, so it is directly unit-testable.
 */
import type { ToolCall } from '@/lib/acp-api'
import {
  asRecord,
  codexActivity,
  codexThreadIds,
  firstString,
  isCodexSpawnCall,
  isSubagentCall,
  isSubagentControlCall,
  isSubagentRunning,
  isToolCallRunning
} from './tool-call-summary'

/** `stopped`: still pending/in_progress after the turn ended (cancel or crash). Counts as failed. */
export type SubagentStatus = 'running' | 'done' | 'failed' | 'stopped'

export interface SubagentCounts {
  running: number
  done: number
  failed: number
}

/** Fields of the latest user message the turn boundary needs. */
export interface TurnBoundary {
  seq?: number
  timestamp?: number
}

function isAfterBoundary(toolCall: ToolCall, boundary: TurnBoundary): boolean {
  if (typeof toolCall.seq === 'number' && typeof boundary.seq === 'number') {
    return toolCall.seq > boundary.seq
  }
  if (typeof toolCall.timestamp === 'number' && typeof boundary.timestamp === 'number') {
    return toolCall.timestamp > boundary.timestamp
  }
  // An unstamped boundary cannot split turns, so it does not hide anything.
  if (typeof boundary.seq !== 'number' && typeof boundary.timestamp !== 'number') return true
  // Live ingest always stamps seq + timestamp (and backfills them on a legacy
  // record), so a call that still cannot be compared is old history.
  return false
}

/**
 * One pill row per agent. Codex control calls (`wait`, `sendInput`, ...) and
 * activity cards report on an agent that another row represents, so they are
 * not rows. A `started` activity card is the row only when no spawn call in
 * the session names its thread (for example, a history replay without spawns).
 */
function isAgentRow(toolCall: ToolCall, spawnedThreads: ReadonlySet<string>): boolean {
  if (!isSubagentCall(toolCall)) return false
  const activity = codexActivity(toolCall)
  if (activity) return activity.kind === 'started' && !spawnedThreads.has(activity.threadId)
  return !isSubagentControlCall(toolCall)
}

/**
 * Subagent calls of the current turn: those that arrived after the latest user
 * message (all of them when there is none). Restored summaries never count.
 */
export function selectCurrentTurnSubagents(
  toolCalls: readonly ToolCall[],
  lastUserMessage: TurnBoundary | null
): ToolCall[] {
  const spawnedThreads = new Set(toolCalls.filter(isCodexSpawnCall).flatMap(codexThreadIds))
  return toolCalls.filter(
    (tc) =>
      !tc.restoredSummary &&
      isAgentRow(tc, spawnedThreads) &&
      (lastUserMessage === null || isAfterBoundary(tc, lastUserMessage))
  )
}

export function subagentStatus(toolCall: ToolCall, turnActive: boolean): SubagentStatus {
  if (isSubagentRunning(toolCall, turnActive)) return 'running'
  switch (toolCall.subagentLifecycle?.state) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'stopped'
  }
  if (isToolCallRunning(toolCall)) return 'stopped'
  return toolCall.status === 'failed' ? 'failed' : 'done'
}

/** True for a dispatch that keeps running after its launch call returns. */
export function isBackgroundSubagent(toolCall: ToolCall): boolean {
  return toolCall.subagentLifecycle?.background === true
}

const NO_CHILD_CALLS: readonly ToolCall[] = []

/** The tool calls a subagent made, in arrival order (same array when none). */
export function subagentChildCalls(
  toolCalls: readonly ToolCall[] | undefined,
  dispatchId: string
): readonly ToolCall[] {
  const children = (toolCalls ?? []).filter((tc) => tc.parentToolCallId === dispatchId)
  return children.length > 0 ? children : NO_CHILD_CALLS
}

/**
 * Row duration in ms: live elapsed while running; otherwise the agent's own
 * total, the host end stamp, or the pill's observed settle time, in that order.
 */
export function subagentDurationMs(
  toolCall: ToolCall,
  status: SubagentStatus,
  now: number,
  observedSettledAt: number | undefined
): number | undefined {
  const started = typeof toolCall.timestamp === 'number' ? toolCall.timestamp : null
  if (status === 'running') return started === null ? undefined : now - started
  const total = toolCall.subagentUsage?.totalDurationMs
  if (total !== undefined && !isBackgroundSubagent(toolCall)) return total
  if (started === null) return total
  const endedAt = toolCall.subagentLifecycle?.endedAt ?? observedSettledAt
  return endedAt !== undefined ? Math.max(0, endedAt - started) : total
}

export function countSubagents(
  toolCalls: readonly ToolCall[],
  turnActive: boolean
): SubagentCounts {
  const counts: SubagentCounts = { running: 0, done: 0, failed: 0 }
  for (const tc of toolCalls) {
    const status = subagentStatus(tc, turnActive)
    counts[status === 'stopped' ? 'failed' : status] += 1
  }
  return counts
}

export function subagentTitle(toolCall: ToolCall): string {
  const input = asRecord(toolCall.rawInput)
  return firstString(input, ['description']) ?? firstString(toolCall, ['title']) ?? 'Subagent'
}

export function subagentType(toolCall: ToolCall): string | undefined {
  return firstString(asRecord(toolCall.rawInput), ['subagent_type', 'subagentType'])
}

/** Total tokens and duration lifted from the agent's `toolResponse` at ingest. */
export function subagentMetrics(toolCall: ToolCall): {
  totalTokens?: number
  totalDurationMs?: number
} {
  const usage = toolCall.subagentUsage
  return { totalTokens: usage?.totalTokens, totalDurationMs: usage?.totalDurationMs }
}

/** `mm:ss`, or `h:mm:ss` from one hour up. Negative/NaN clamp to 0. */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** `842 tok`, `37.8k tok`, `1.2M tok`. */
export function formatTokens(tokens: number): string {
  const n = Math.max(0, Math.round(tokens))
  if (n < 1000) return `${n} tok`
  const compact = (value: number, unit: string): string =>
    `${value.toFixed(1).replace(/\.0$/, '')}${unit} tok`
  if (n < 1_000_000) return compact(n / 1000, 'k')
  return compact(n / 1_000_000, 'M')
}
