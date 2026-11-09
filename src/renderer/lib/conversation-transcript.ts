import { buildConversationContext, capContextFragment } from '@/components/chat/handoff-summary'
import type { ContentBlock, ToolCall } from '@/lib/acp-api'
import { acpHistoryApi } from '@/lib/acp-history-api'
import { getAcpTransport } from '@/lib/acp-transport'
import { conversationEnvelope, type TranscriptGap } from '@/lib/conversation-envelope'
import { logFrontendError } from '@/lib/log-api'
import { membersOf, sessionChainIndex } from '@/lib/session-chain'
import { type ChatMessage, useAcpStore } from '@/stores/acp-store'

const TRANSCRIPT_TAIL_LIMIT = 200
// Total transcript characters one send carries across all of its chat pills.
const CONVERSATION_CONTEXT_CHARS = 30_000

interface Transcript {
  messages: ChatMessage[]
  toolCalls: ToolCall[]
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

export async function readConversationTranscript(sessionId: string): Promise<Transcript | null> {
  const state = useAcpStore.getState()
  const loaded = state.messages[sessionId]
  // The mention picker folds a switch chain into its terminal row, so a
  // terminal-only read would silently drop every pre-switch turn. When the
  // loaded transcript already carries the merged band (reopen splice), it
  // IS the whole conversation; otherwise read every chain member's durable
  // payload oldest → newest (durable logs never contain bands, so there is
  // nothing to de-duplicate).
  const memberIds = membersOf(sessionChainIndex(state.sessionIndex), sessionId)
  if (loaded && !state.sessions[sessionId]?.replaying) {
    if ((state.agentSwitches[sessionId]?.length ?? 0) >= memberIds.length - 1) {
      return { messages: loaded, toolCalls: state.toolCalls[sessionId] ?? [] }
    }
  } else if (memberIds.length === 1) {
    return readPersistedTranscript(sessionId)
  }
  const parts = await Promise.all(memberIds.map(readPersistedTranscript))
  if (parts.every((part) => part === null)) return null
  const messages: ChatMessage[] = []
  const toolCalls: ToolCall[] = []
  for (const part of parts) {
    if (!part) continue
    messages.push(...part.messages)
    toolCalls.push(...part.toolCalls)
  }
  return { messages, toolCalls }
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
