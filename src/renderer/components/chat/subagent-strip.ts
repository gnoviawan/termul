/**
 * Pure helpers for the top-right subagent pill: pick the current
 * turn's subagent calls and derive each row's status, title, tokens, and
 * duration. No React/store dependency, so it is directly unit-testable.
 */
import type { SubagentEndReason } from '@shared/types/subagent'
import type { ContentBlock, ToolCall } from '@/lib/acp-api'
import {
  describeToolCall,
  isSubagentCall,
  isSubagentRunning,
  type ParentTurn,
  readableOutput
} from './tool-call-summary'

/** `stopped`: cancelled, ended without a reason, or lost when its turn ended. */
export type SubagentStatus = 'running' | 'done' | 'failed' | 'stopped'

export type SubagentCounts = Record<SubagentStatus, number>

/** Fields of the latest user message the turn boundary needs. */
export interface TurnBoundary {
  seq?: number
  timestamp?: number
}

/** The latest user message as a turn boundary, or null when the chat has none. */
export function lastUserBoundary(
  messages: readonly (TurnBoundary & { role: string })[] | undefined
): TurnBoundary | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'user') return { seq: message.seq, timestamp: message.timestamp }
  }
  return null
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
 * Subagent calls of the current turn: those that arrived after the latest user
 * message (all of them when there is none). Restored summaries never count.
 * The host attaches a record only to the call that represents the subagent,
 * so calls that steer one (Codex `wait`, activity cards) are not rows.
 */
export function selectCurrentTurnSubagents(
  toolCalls: readonly ToolCall[],
  lastUserMessage: TurnBoundary | null
): ToolCall[] {
  return toolCalls.filter(
    (tc) =>
      !tc.restoredSummary &&
      isSubagentCall(tc) &&
      (lastUserMessage === null || isAfterBoundary(tc, lastUserMessage))
  )
}

const NO_SUBAGENTS: ToolCall[] = []

/**
 * Background subagents of a chat that have not ended: one its source reports
 * running live (any turn), or a background launch of the latest turn that has
 * not ended. They outlive the turn, so a restart of the agent process would
 * kill them.
 */
export function runningBackgroundSubagents(
  toolCalls: readonly ToolCall[] | undefined,
  messages: readonly (TurnBoundary & { role: string })[] | undefined
): ToolCall[] {
  if (!toolCalls) return NO_SUBAGENTS
  const launches = toolCalls.filter((tc) => {
    const record = tc.subagent
    if (!record) return false
    const active = record.activity === 'running' || record.activity === 'requires_action'
    return record.background || (record.caps.liveProgress && active)
  })
  if (launches.length === 0) return NO_SUBAGENTS
  const boundary = lastUserBoundary(messages)
  return launches.filter(
    (tc) =>
      !tc.restoredSummary &&
      isSubagentRunning(
        tc,
        boundary === null || isAfterBoundary(tc, boundary) ? 'ended' : 'superseded'
      )
  )
}

/**
 * Pill rows: the current turn's subagents, then the running background
 * launches they lack (older turns), so every subagent the chat waits on has a row.
 */
export function withRunningBackground(
  current: ToolCall[],
  background: readonly ToolCall[]
): ToolCall[] {
  const ids = new Set(current.map((tc) => tc.toolCallId))
  const earlier = background.filter((tc) => !ids.has(tc.toolCallId))
  return earlier.length === 0 ? current : [...current, ...earlier]
}

const END_STATUS: Record<SubagentEndReason, SubagentStatus> = {
  completed: 'done',
  failed: 'failed',
  cancelled: 'stopped',
  unexplained: 'stopped'
}

/**
 * Where a subagent's turn stands: the latest turn is `active` while the chat
 * runs it and `ended` after; an older turn is `superseded`.
 */
export function subagentParentTurn(
  toolCall: ToolCall,
  lastUserMessage: TurnBoundary | null,
  turnActive: boolean
): ParentTurn {
  if (lastUserMessage !== null && !isAfterBoundary(toolCall, lastUserMessage)) return 'superseded'
  return turnActive ? 'active' : 'ended'
}

/**
 * An `unknown` record is not a failure. A record still running that the turn
 * rules no longer count lost its end: a background launch reads as done, a
 * foreground one as stopped.
 */
export function subagentStatus(toolCall: ToolCall, parentTurn: ParentTurn): SubagentStatus {
  if (isSubagentRunning(toolCall, parentTurn)) return 'running'
  const record = toolCall.subagent
  if (!record) return 'stopped'
  switch (record.activity) {
    case 'idle':
      return END_STATUS[record.end.reason]
    case 'unknown':
      return 'stopped'
    case 'running':
    case 'requires_action':
      return record.background ? 'done' : 'stopped'
  }
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
 * Row duration in ms from the host start stamp (the call's arrival when
 * absent): live elapsed while running; otherwise the agent's own total, the
 * host end stamp, or the pill's observed settle time, in that order.
 */
export function subagentDurationMs(
  toolCall: ToolCall,
  status: SubagentStatus,
  now: number,
  observedSettledAt: number | undefined
): number | undefined {
  const record = toolCall.subagent
  const started =
    record?.startedAt ?? (typeof toolCall.timestamp === 'number' ? toolCall.timestamp : null)
  if (status === 'running') return started === null ? undefined : now - started
  const total = record?.usage?.durationMs
  if (total !== undefined && !record?.background) return total
  if (started === null) return total
  const endedAt = record?.endedAt ?? observedSettledAt
  return endedAt !== undefined ? Math.max(0, endedAt - started) : total
}

export function countSubagents(statuses: readonly SubagentStatus[]): SubagentCounts {
  const counts: SubagentCounts = { running: 0, done: 0, failed: 0, stopped: 0 }
  for (const status of statuses) counts[status] += 1
  return counts
}

export function subagentTitle(toolCall: ToolCall): string {
  return toolCall.subagent?.title ?? toolCall.title ?? 'Subagent'
}

/** The agent type chip: the role the agent names, else its stated purpose. */
export function subagentType(toolCall: ToolCall): string | undefined {
  return toolCall.subagent?.role ?? toolCall.subagent?.description
}

/** `42s`, `3m 05s`, `1h 02m`. Negative/NaN clamp to `0s`. */
export function formatSubagentElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (hours > 0) return `${hours}h ${pad(minutes)}m`
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`
  return `${seconds}s`
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

function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  return line && line.length > 0 ? line : undefined
}

function lastLine(text: string | undefined): string | undefined {
  const lines = text?.split('\n').map((part) => part.trim()) ?? []
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]) return lines[i]
  return undefined
}

/**
 * The subagent's final answer, once. A foreground dispatch returns it as the
 * call's result; a background launch returns only a receipt, so its answer is
 * the text it streamed, if any.
 */
export function subagentResultText(toolCall: ToolCall): string | undefined {
  const streamed = toolCall.subagentText?.trim() ? toolCall.subagentText : undefined
  if (toolCall.subagent?.background) return streamed
  const text = (toolCall.content ?? [])
    .flatMap((item) => {
      const block =
        item.type === 'content' ? (item as { content?: ContentBlock }).content : undefined
      return block?.type === 'text' && block.text ? [block.text] : []
    })
    .join('\n\n')
  if (text.trim()) return text
  const raw = readableOutput(toolCall.rawOutput)
  return raw.trim() ? raw : streamed
}

/** Tool calls the subagent made, from its live transcript or the usage it reported. */
export function subagentToolCount(
  toolCall: ToolCall,
  childCalls: readonly ToolCall[]
): number | undefined {
  if (childCalls.length > 0) return childCalls.length
  return toolCall.subagent?.usage?.toolUses
}

export type SubagentDetailTone = 'muted' | 'destructive'

/**
 * The row's one detail line: latest progress while running (its newest tool
 * call, else its newest line of text), the error or first line of the result
 * once settled. Undefined when the agent reported nothing to show.
 */
export function subagentDetail(
  toolCall: ToolCall,
  status: SubagentStatus,
  childCalls: readonly ToolCall[]
): { text: string; tone: SubagentDetailTone } | undefined {
  const record = toolCall.subagent
  if (status === 'running') {
    const latest = childCalls[childCalls.length - 1]
    const count = subagentToolCount(toolCall, childCalls)
    const tools = count ? `${count} ${count === 1 ? 'tool' : 'tools'}` : undefined
    const progress = latest
      ? (() => {
          const { verb, primary } = describeToolCall(latest)
          return `${verb} ${primary}`.trim()
        })()
      : lastLine(toolCall.subagentText)
    const text = [progress, tools].filter(Boolean).join(' · ')
    return text ? { text, tone: 'muted' } : undefined
  }
  if (status === 'failed') {
    const error = record?.activity === 'idle' ? firstLine(record.end.error) : undefined
    const text = error ?? firstLine(subagentResultText(toolCall))
    return text ? { text, tone: 'destructive' } : undefined
  }
  const text = firstLine(subagentResultText(toolCall))
  return text ? { text, tone: 'muted' } : undefined
}
