/**
 * Canonical subagent fixtures: the host's {@link Subagent} record and the
 * dispatch tool call that carries it.
 */
import {
  SUBAGENT_META_KEY,
  type Subagent,
  type SubagentCaps,
  type SubagentId,
  type SubagentState
} from '@shared/types/subagent'
import type { ToolCall } from '@/lib/acp-api'

export type SubagentRecordOverrides = Partial<Omit<Subagent, 'activity' | 'end' | 'caps'>> & {
  state?: SubagentState
  caps?: Partial<SubagentCaps>
}

/** A running foreground Claude subagent unless overridden. */
export function subagentRecord(overrides: SubagentRecordOverrides = {}): Subagent {
  const { state = { activity: 'running' }, caps, ...fields } = overrides
  return {
    id: (fields.dispatchToolCallId ?? 'agent-1') as SubagentId,
    rootSessionId: 's1',
    dispatchToolCallId: 'agent-1',
    source: 'claude-meta',
    title: 'Audit code',
    background: false,
    caps: { stop: null, transcript: 'live', liveProgress: false, usage: true, ...caps },
    ...fields,
    ...state
  }
}

/** An idle record's state for `reason`. */
export function endedState(
  reason: 'completed' | 'cancelled' | 'failed' | 'unexplained' = 'completed'
): SubagentState {
  return { activity: 'idle', end: { reason } }
}

/**
 * A dispatch tool call carrying `record` as the store holds it after ingest.
 * The record's `dispatchToolCallId` follows the call id.
 */
export function subagentToolCall(
  record: SubagentRecordOverrides = {},
  call: Partial<ToolCall> = {}
): ToolCall {
  const toolCallId = call.toolCallId ?? record.dispatchToolCallId ?? 'agent-1'
  return {
    toolCallId,
    title: 'Task',
    kind: 'think',
    status: 'in_progress',
    ...call,
    subagent: subagentRecord({ dispatchToolCallId: toolCallId, ...record })
  }
}

/** The wire `_meta` that carries `record`. */
export function subagentMeta(record: Subagent): Record<string, unknown> {
  return { [SUBAGENT_META_KEY]: record }
}
