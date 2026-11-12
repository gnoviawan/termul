import { buildConversationContext, capContextFragment } from '@/components/chat/handoff-summary'
import type { ContentBlock, ToolCall } from '@/lib/acp-api'
import { acpHistoryApi } from '@/lib/acp-history-api'
import { getAcpTransport } from '@/lib/acp-transport'
import { conversationEnvelope, type TranscriptGap } from '@/lib/conversation-envelope'
import { logFrontendError } from '@/lib/log-api'
import { projectScopedMembers } from '@/lib/session-chain'
import { type ChatMessage, useAcpStore } from '@/stores/acp-store'
import { SWITCH_SPLICE_ID_PREFIX } from '@/stores/acp-store/helpers'

const TRANSCRIPT_TAIL_LIMIT = 200
// Total transcript characters one send carries across all of its chat pills.
const CONVERSATION_CONTEXT_CHARS = 30_000

interface Transcript {
  messages: ChatMessage[]
  toolCalls: ToolCall[]
  /** A chain member was unreadable — the returned context is partial. */
  partial?: boolean
}

async function readPersistedTranscript(sessionId: string): Promise<Transcript | null> {
  const transport = getAcpTransport()
  const mode = transport.historyMode?.()
  if (mode === 'live_only') return null
  const payload =
    mode === 'server' && transport.getSessionPayloadTail
      ? await transport.getSessionPayloadTail(sessionId, TRANSCRIPT_TAIL_LIMIT)
      : await acpHistoryApi.getTail(sessionId, TRANSCRIPT_TAIL_LIMIT)
  return payload ? { messages: payload.messages, toolCalls: payload.toolCalls ?? [] } : null
}

type AcpSnapshot = ReturnType<typeof useAcpStore.getState>

/**
 * A member's own turns from the live store — the reopen splice namespaces
 * every band record `switch-splice:<sourceId>:`, so stripping them yields
 * exactly this session's contribution (no band can be counted twice).
 */
function ownTurns(state: AcpSnapshot, sessionId: string): Transcript | null {
  const loaded = state.messages[sessionId]
  // An empty live list (a cleared or failed reopen) is not the member's
  // history: let the durable read supply it.
  if (!loaded || loaded.length === 0 || state.sessions[sessionId]?.replaying) return null
  return {
    messages: loaded.filter((m) => !m.id.startsWith(SWITCH_SPLICE_ID_PREFIX)),
    toolCalls: (state.toolCalls[sessionId] ?? []).filter(
      (t) => !t.toolCallId.startsWith(SWITCH_SPLICE_ID_PREFIX)
    )
  }
}

export async function readConversationTranscript(sessionId: string): Promise<Transcript | null> {
  const state = useAcpStore.getState()
  // The mention picker folds a switch chain into its terminal row, so a
  // terminal-only read would silently drop every pre-switch turn. Project
  // scoping keeps a malformed cross-project edge from leaking another
  // project's transcript into this conversation.
  const memberIds = projectScopedMembers(state.sessionIndex, sessionId)
  const loaded = state.messages[sessionId]
  if (loaded && !state.sessions[sessionId]?.replaying) {
    // Use the loaded transcript only when its splice provably covers every
    // ancestor — a marker count alone can pass while the band itself is
    // missing (a failed reload leaves own turns with the switch recorded).
    // A live switch re-splices the previous target's list, so an earlier
    // hop's band nests (`switch-splice:B:switch-splice:A:<id>`).
    const coversAncestors = memberIds
      .filter((memberId) => memberId !== sessionId)
      .every((ancestorId) =>
        loaded.some((m) =>
          m.id
            .split(SWITCH_SPLICE_ID_PREFIX)
            .slice(1)
            .some((band) => band.startsWith(`${ancestorId}:`))
        )
      )
    if (coversAncestors) return { messages: loaded, toolCalls: state.toolCalls[sessionId] ?? [] }
  } else if (memberIds.length === 1) {
    return readPersistedTranscript(sessionId)
  }
  // Per member, prefer own-turns from the live store (freshest, band-free);
  // the durable payload is the fallback and the only source for cold members.
  // A member whose durable read rejects counts as unreadable: the others'
  // turns still go out, marked partial.
  const parts = await Promise.all(
    memberIds.map(
      (memberId) => ownTurns(state, memberId) ?? readPersistedTranscript(memberId).catch(() => null)
    )
  )
  if (parts.every((part) => part === null)) return null
  // Each member's payload restarts its seq space at 1 — re-stamp into
  // increasing bands so the context formatter's seq-first sort preserves
  // chain order instead of interleaving same-seqd turns. Each band spans the
  // member's highest seq actually read, so a stale or missing index cursor
  // cannot make the next member's records sort before this one's.
  const lastSeqById = new Map(state.sessionIndex.map((entry) => [entry.id, entry.lastSeq ?? 0]))
  const messages: ChatMessage[] = []
  const toolCalls: ToolCall[] = []
  let offset = 0
  let partial = false
  memberIds.forEach((memberId, i) => {
    const part = parts[i]
    if (!part) {
      partial = true
      void logFrontendError({
        level: 'warn',
        source: 'conversationTranscript',
        message: `Mentioned chat member ${memberId.slice(0, 8)}… unreadable; context is partial`
      })
      return
    }
    for (const message of part.messages) {
      messages.push({ ...message, seq: offset + (message.seq ?? 0) })
    }
    for (const call of part.toolCalls) {
      toolCalls.push({ ...call, seq: offset + (call.seq ?? 0) })
    }
    let span = Math.max(lastSeqById.get(memberId) ?? 0, 1)
    for (const record of [...part.messages, ...part.toolCalls]) {
      span = Math.max(span, record.seq ?? 0)
    }
    offset += span
  })
  return { messages, toolCalls, ...(partial ? { partial: true } : {}) }
}

function agentNameOf(sessionId: string): string | null {
  const { sessionIndex, agentConfigs } = useAcpStore.getState()
  const configId = sessionIndex.find((e) => e.id === sessionId)?.agentConfigId
  return agentConfigs.find((c) => c.id === configId)?.name ?? null
}

export interface ConversationContexts {
  blocks: ContentBlock[]
  gaps: ReadonlyMap<string, TranscriptGap>
}

export async function resolveConversationContexts(
  refs: ReadonlyArray<{ title: string; sessionId: string }>
): Promise<ConversationContexts> {
  const blocks: ContentBlock[] = []
  const gaps = new Map<string, TranscriptGap>()
  let contextChars = 0
  let omitted = 0
  for (const { title, sessionId } of refs) {
    // Once one transcript misses the limit, the later ones are not read at all.
    if (omitted > 0) {
      gaps.set(sessionId, 'omitted')
      omitted++
      continue
    }
    const transcript = await readConversationTranscript(sessionId).catch((err: unknown) => {
      void logFrontendError({
        level: 'warn',
        source: 'conversationTranscript',
        message: `Mentioned chat ${sessionId.slice(0, 8)}… transcript read failed: ${err instanceof Error ? err.message : String(err)}`
      })
      return undefined
    })
    if (transcript === null) {
      void logFrontendError({
        level: 'warn',
        source: 'conversationTranscript',
        message: `Mentioned chat ${sessionId.slice(0, 8)}… has no readable history`
      })
    }
    if (!transcript) {
      gaps.set(sessionId, 'unavailable')
      continue
    }
    if (transcript.partial) {
      gaps.set(sessionId, 'partial')
    }
    const contextTitle = capContextFragment(title)
    const body = buildConversationContext({
      title: contextTitle,
      messages: transcript.messages,
      toolCalls: transcript.toolCalls,
      agentName: agentNameOf(sessionId)
    })
    const text = conversationEnvelope(sessionId, contextTitle, body)
    if (contextChars + text.length > CONVERSATION_CONTEXT_CHARS) {
      gaps.set(sessionId, 'omitted')
      omitted++
      continue
    }
    contextChars += text.length
    blocks.push({ type: 'text', text })
  }
  if (omitted > 0) {
    void logFrontendError({
      level: 'warn',
      source: 'conversationTranscript',
      message: `Omitted ${omitted} of ${refs.length} mentioned chat transcripts: over the ${CONVERSATION_CONTEXT_CHARS}-character context limit`
    })
  }
  return { blocks, gaps }
}
