/**
 * Keep subagent work inside its subagent. Claude stamps
 * `_meta.claudeCode.parentToolUseId` on every tool call and text chunk that a
 * subagent makes (the host stamps the same key on native child-session
 * traffic). The store lifts that id onto the child tool call, and appends the
 * subagent's text to its dispatch call instead of the main reply.
 */

import { asRecord } from '@/components/chat/tool-call-summary'
import type { MessageChunkEvent, ToolCall } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { withSubagentLifecycle } from './subagent-lifecycle'
import { withSubagentUsage } from './subagent-usage'
import type { AcpState } from './types'

const MAX_PARENT_ID_CHARS = 512
/** Tail of the subagent text kept on its dispatch call. */
export const MAX_SUBAGENT_TEXT_CHARS = 8_000

const loggedOrphans = new Set<string>()

function parentToolCallId(meta: unknown): string | undefined {
  const id = asRecord(asRecord(meta)?.claudeCode)?.parentToolUseId
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_PARENT_ID_CHARS
    ? id
    : undefined
}

/** `call` with the subagent that made it; the same object when none did. */
export function withParentToolCallId<T extends { toolCallId: string; _meta?: unknown }>(
  call: T
): T {
  const parent = parentToolCallId(call._meta)
  return parent && parent !== call.toolCallId ? { ...call, parentToolCallId: parent } : call
}

/** Every ingest-time subagent field: usage, lifecycle, and parent dispatch. */
export function withSubagentIngest<
  T extends { toolCallId: string; rawInput?: unknown; _meta?: unknown }
>(call: T): T {
  return withParentToolCallId(withSubagentLifecycle(withSubagentUsage(call)))
}

/** The subagent text a chunk adds; null for thought, user, and non-text chunks. */
export function subagentChunkText(role: unknown, content: unknown): string | null {
  const block = asRecord(content)
  if (role !== 'agent' || block?.type !== 'text') return null
  return typeof block.text === 'string' && block.text.length > 0 ? block.text : null
}

/** `call` with `text` appended to its subagent text, keeping the newest tail. */
export function withSubagentText(call: ToolCall, text: string): ToolCall {
  const joined = `${call.subagentText ?? ''}${text}`
  return {
    ...call,
    subagentText:
      joined.length > MAX_SUBAGENT_TEXT_CHARS ? joined.slice(-MAX_SUBAGENT_TEXT_CHARS) : joined
  }
}

/**
 * Append a subagent text chunk to its dispatch call. Thought chunks and
 * non-text blocks are not kept. A chunk whose dispatch call is unknown is
 * dropped (logged once per parent id): it never joins the main reply.
 */
export function appendSubagentChunk(
  s: AcpState,
  e: MessageChunkEvent & { parentToolCallId: string }
): Partial<AcpState> {
  const session = s.sessions[e.sessionId]
  if (!session || (session.status === 'closed' && !session.replaying)) return {}
  const text = subagentChunkText(e.role, e.content)
  if (text === null) return {}
  const list = s.toolCalls[e.sessionId] ?? []
  const idx = list.findIndex((tc) => tc.toolCallId === e.parentToolCallId)
  if (idx === -1) {
    const key = e.parentToolCallId.slice(0, 128)
    if (!loggedOrphans.has(key)) {
      if (loggedOrphans.size >= 256) loggedOrphans.clear()
      loggedOrphans.add(key)
      void logFrontendError({
        level: 'info',
        source: 'acp-store.subagentText',
        message: `Dropped subagent text for unknown dispatch ${key} in session ${e.sessionId}`
      })
    }
    return {}
  }
  const next = [...list]
  next[idx] = withSubagentText(list[idx], text)
  return { toolCalls: { ...s.toolCalls, [e.sessionId]: next } }
}

/** Reset the orphan log dedup (tests). */
export function _resetSubagentTranscriptLogsForTesting(): void {
  loggedOrphans.clear()
}
