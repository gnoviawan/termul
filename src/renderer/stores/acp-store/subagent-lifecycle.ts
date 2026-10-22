/**
 * Derive `ToolCall.subagentLifecycle` at ingest. A background subagent
 * completes its tool call at launch, so the tool-call status cannot tell when
 * the agent ends. Sources, in the order they are read:
 *
 * - `_meta["termul/subagent"]`: the host's native subagent state (Claude
 *   native subagent sessions), already normalized to
 *   running/completed/failed/cancelled.
 * - `_meta.claudeCode.toolResponse`: Claude's `async_launched` launch receipt.
 * - `rawOutput.isBackground`: Cursor's background task result.
 * - `rawInput.run_in_background` (or `background`, OpenCode): the request for
 *   a background launch.
 *
 * Codex reports agent state on other tool calls (`agentsStates` and activity
 * cards), so {@link applyCodexThreadStates} patches it onto the spawn calls.
 */

import {
  asRecord,
  BACKGROUND_INPUT_KEYS,
  codexActivity,
  codexThreadIds,
  firstString,
  isCodexCollabCall,
  isCodexSpawnCall
} from '@/components/chat/tool-call-summary'
import type { SubagentLifecycle, SubagentLifecycleState, ToolCall } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'

export const TERMUL_SUBAGENT_META_KEY = 'termul/subagent'

const MAX_LIFECYCLE_STRING_CHARS = 512
const BACKGROUND_LAUNCH_STATUSES = new Set(['async_launched', 'remote_launched'])
const LIFECYCLE_STATES = new Set<SubagentLifecycleState>([
  'running',
  'completed',
  'failed',
  'cancelled'
])

/** Dedup cap for the info log, FIFO-evicted (an evicted id may re-log once). */
const MAX_LOGGED_KEYS = 256
const loggedKeys = new Set<string>()

function logOnce(toolCallId: string, event: string, message: string): void {
  const key = `${toolCallId.slice(0, 128)}:${event}`
  if (loggedKeys.has(key)) return
  if (loggedKeys.size >= MAX_LOGGED_KEYS) {
    const oldest = loggedKeys.values().next().value
    if (oldest !== undefined) loggedKeys.delete(oldest)
  }
  loggedKeys.add(key)
  void logFrontendError({ level: 'info', source: 'acp-store.subagentLifecycle', message })
}

function boundedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LIFECYCLE_STRING_CHARS
    ? value
    : undefined
}

function isLifecycleState(value: unknown): value is SubagentLifecycleState {
  return typeof value === 'string' && LIFECYCLE_STATES.has(value as SubagentLifecycleState)
}

export function isTerminalLifecycleState(state: SubagentLifecycleState | undefined): boolean {
  return state !== undefined && state !== 'running'
}

function withoutUndefined(lifecycle: SubagentLifecycle): SubagentLifecycle | undefined {
  const entries = Object.entries(lifecycle).filter(([, value]) => value !== undefined)
  return entries.length > 0 ? (Object.fromEntries(entries) as SubagentLifecycle) : undefined
}

function fromHostMarker(meta: Record<string, unknown> | null): SubagentLifecycle | undefined {
  const marker = asRecord(meta?.[TERMUL_SUBAGENT_META_KEY])
  if (!marker) return undefined
  const endedAt = marker.endedAt
  return withoutUndefined({
    state: isLifecycleState(marker.state) ? marker.state : undefined,
    endedAt:
      typeof endedAt === 'number' && Number.isFinite(endedAt) && endedAt > 0 ? endedAt : undefined,
    agentId: boundedString(marker.sessionId)
  })
}

function fromLaunchReceipt(meta: Record<string, unknown> | null): SubagentLifecycle | undefined {
  const response = asRecord(asRecord(meta?.claudeCode)?.toolResponse)
  if (!response) return undefined
  const background =
    response.isAsync === true ||
    (typeof response.status === 'string' && BACKGROUND_LAUNCH_STATUSES.has(response.status))
  if (!background) return undefined
  return withoutUndefined({
    background: true,
    agentId: boundedString(response.agentId),
    outputFile: boundedString(response.outputFile)
  })
}

function fromRawInput(rawInput: unknown): SubagentLifecycle | undefined {
  const input = asRecord(rawInput)
  if (!input || !BACKGROUND_INPUT_KEYS.some((key) => input[key] === true)) return undefined
  return { background: true }
}

function fromRawOutput(rawOutput: unknown): SubagentLifecycle | undefined {
  return asRecord(rawOutput)?.isBackground === true ? { background: true } : undefined
}

/** Lifecycle fields carried by one tool call or update, or undefined when none. */
export function extractSubagentLifecycle(call: {
  toolCallId: string
  rawInput?: unknown
  rawOutput?: unknown
  _meta?: unknown
}): SubagentLifecycle | undefined {
  const meta = asRecord(call._meta)
  const launch = mergeSubagentLifecycle(fromRawInput(call.rawInput), fromRawOutput(call.rawOutput))
  const merged = mergeSubagentLifecycle(
    mergeSubagentLifecycle(launch, fromLaunchReceipt(meta)),
    fromHostMarker(meta)
  )
  if (merged?.background) {
    logOnce(call.toolCallId, 'background', `Subagent ${call.toolCallId} runs in the background`)
  }
  if (isTerminalLifecycleState(merged?.state)) {
    logOnce(call.toolCallId, 'ended', `Subagent ${call.toolCallId} ended: ${merged?.state}`)
  }
  return merged
}

/** Field-wise merge: a later update adds or replaces fields, never clears them. */
export function mergeSubagentLifecycle(
  prev: SubagentLifecycle | undefined,
  next: SubagentLifecycle | undefined
): SubagentLifecycle | undefined {
  if (!prev) return next
  if (!next) return prev
  const merged = { ...prev, ...withoutUndefined(next) }
  if (merged.state === 'running') delete merged.endedAt
  return merged
}

/**
 * The agent process is gone, so a subagent still marked `running` will never
 * receive its end. Marks those calls `cancelled`. Returns the same map when
 * nothing was running.
 */
export function cancelRunningSubagents(
  toolCalls: Record<string, ToolCall[]>,
  sessionIds: readonly string[],
  endedAt: number
): Record<string, ToolCall[]> {
  let next: Record<string, ToolCall[]> | null = null
  for (const sessionId of sessionIds) {
    const calls = toolCalls[sessionId]
    if (!calls) continue
    let count = 0
    const settled = calls.map((call) => {
      if (call.subagentLifecycle?.state !== 'running') return call
      count += 1
      return {
        ...call,
        subagentLifecycle: {
          ...call.subagentLifecycle,
          state: 'cancelled' as const,
          endedAt: call.subagentLifecycle.endedAt ?? endedAt
        }
      }
    })
    if (count === 0) continue
    if (!next) next = { ...toolCalls }
    next[sessionId] = settled
    void logFrontendError({
      level: 'info',
      source: 'acp-store.subagentLifecycle',
      message: `Cancelled ${count} running subagents on chat ${sessionId}: the agent process is gone`
    })
  }
  return next ?? toolCalls
}

/** `call` with the lifecycle it carries; the same object when it carries none. */
export function withSubagentLifecycle<
  T extends { toolCallId: string; rawInput?: unknown; rawOutput?: unknown; _meta?: unknown }
>(call: T): T {
  const subagentLifecycle = extractSubagentLifecycle(call)
  return subagentLifecycle ? { ...call, subagentLifecycle } : call
}

// ---------------------------------------------------------------------------
// Codex: agent state arrives on collab tool calls and activity cards.
// ---------------------------------------------------------------------------

const CODEX_THREAD_STATUS: Record<string, SubagentLifecycleState> = {
  pendingInit: 'running',
  running: 'running',
  completed: 'completed',
  errored: 'failed',
  notFound: 'failed',
  interrupted: 'cancelled',
  shutdown: 'cancelled'
}

const CODEX_ACTIVITY_STATE: Record<string, SubagentLifecycleState> = {
  started: 'running',
  interacted: 'running',
  completed: 'completed',
  interrupted: 'cancelled'
}

function order(call: ToolCall): number {
  return typeof call.seq === 'number' ? call.seq : (call.timestamp ?? 0)
}

/** A completed agent that is later shut down (`closeAgent`) stays completed. */
function nextThreadState(
  prev: SubagentLifecycleState | undefined,
  next: SubagentLifecycleState
): SubagentLifecycleState {
  return prev === 'completed' && next === 'cancelled' ? prev : next
}

function codexThreadStates(calls: readonly ToolCall[]): Map<string, SubagentLifecycleState> {
  const states = new Map<string, SubagentLifecycleState>()
  const relevant = calls
    .filter((call) => isCodexCollabCall(call) || codexActivity(call))
    .sort((a, b) => order(a) - order(b))
  for (const call of relevant) {
    const activity = codexActivity(call)
    if (activity) {
      const state = CODEX_ACTIVITY_STATE[activity.kind]
      if (state)
        states.set(activity.threadId, nextThreadState(states.get(activity.threadId), state))
      continue
    }
    const agentsStates = asRecord(asRecord(call.rawInput)?.agentsStates) ?? {}
    for (const [threadId, value] of Object.entries(agentsStates)) {
      const status = firstString(asRecord(value), ['status'])
      const state = status ? CODEX_THREAD_STATUS[status] : undefined
      if (state) states.set(threadId, nextThreadState(states.get(threadId), state))
    }
  }
  return states
}

function aggregate(states: SubagentLifecycleState[]): SubagentLifecycleState | undefined {
  if (states.length === 0) return undefined
  for (const state of ['running', 'failed', 'cancelled'] as const) {
    if (states.includes(state)) return state
  }
  return 'completed'
}

function sameLifecycle(
  a: SubagentLifecycle | undefined,
  b: SubagentLifecycle | undefined
): boolean {
  return (
    a?.background === b?.background &&
    a?.state === b?.state &&
    a?.agentId === b?.agentId &&
    a?.endedAt === b?.endedAt &&
    a?.outputFile === b?.outputFile
  )
}

/**
 * Patch the Codex thread states onto each spawn call (and onto each `started`
 * activity card). Returns the same array when nothing changed.
 */
export function applyCodexThreadStates(calls: ToolCall[]): ToolCall[] {
  if (!calls.some((call) => isCodexCollabCall(call) || codexActivity(call))) return calls
  const states = codexThreadStates(calls)
  let next: ToolCall[] | null = null
  calls.forEach((call, index) => {
    let threads: string[] = []
    if (isCodexSpawnCall(call)) threads = codexThreadIds(call)
    else if (codexActivity(call)?.kind === 'started')
      threads = [codexActivity(call)?.threadId ?? '']
    const known = threads.flatMap((id) => {
      const state = states.get(id)
      return state ? [state] : []
    })
    const state = aggregate(known)
    if (!state) return
    const lifecycle = mergeSubagentLifecycle(call.subagentLifecycle, {
      background: true,
      state,
      agentId: boundedString(threads[0])
    })
    if (sameLifecycle(call.subagentLifecycle, lifecycle)) return
    if (isTerminalLifecycleState(state)) {
      logOnce(
        call.toolCallId,
        `ended:${state}`,
        `Codex subagent ${call.toolCallId} ended: ${state}`
      )
    }
    next ??= [...calls]
    next[index] = { ...call, subagentLifecycle: lifecycle }
  })
  return next ?? calls
}

/** The merged lifecycle field for an upsert of `next` over `prev` (spread it last). */
export function mergedLifecycleField(
  prev: ToolCall,
  next: { subagentLifecycle?: SubagentLifecycle }
): { subagentLifecycle?: SubagentLifecycle } {
  const subagentLifecycle = mergeSubagentLifecycle(prev.subagentLifecycle, next.subagentLifecycle)
  return subagentLifecycle ? { subagentLifecycle } : {}
}

/** `calls` with Codex thread states applied when `changed` carries Codex agent state. */
export function withCodexThreadStates(calls: ToolCall[], changed: ToolCall): ToolCall[] {
  return isCodexCollabCall(changed) || codexActivity(changed)
    ? applyCodexThreadStates(calls)
    : calls
}

/** Reset the log dedup (tests). */
export function _resetSubagentLifecycleLogsForTesting(): void {
  loggedKeys.clear()
}
