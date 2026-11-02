import { buildConversationContext, capContextFragment } from '@/components/chat/handoff-summary'
import type { ContentBlock, ToolCall } from '@/lib/acp-api'
import { acpHistoryApi } from '@/lib/acp-history-api'
import { getAcpTransport } from '@/lib/acp-transport'
import { conversationEnvelope } from '@/lib/conversation-envelope'
import { logFrontendError } from '@/lib/log-api'
import { type ChatMessage, useAcpStore } from '@/stores/acp-store'

const TRANSCRIPT_TAIL_LIMIT = 200

interface Transcript {
  messages: ChatMessage[]
  toolCalls: ToolCall[]
}

export async function readConversationTranscript(sessionId: string): Promise<Transcript | null> {
  const state = useAcpStore.getState()
  const loaded = state.messages[sessionId]
  if (loaded && !state.sessions[sessionId]?.replaying) {
    return { messages: loaded, toolCalls: state.toolCalls[sessionId] ?? [] }
  }
  const transport = getAcpTransport()
  const mode = transport.historyMode?.()
  if (mode === 'live_only') return null
  const payload =
    mode === 'server' && transport.getSessionPayloadTail
      ? await transport.getSessionPayloadTail(sessionId, TRANSCRIPT_TAIL_LIMIT)
      : await acpHistoryApi.getTail(sessionId, TRANSCRIPT_TAIL_LIMIT)
  return payload ? { messages: payload.messages, toolCalls: payload.toolCalls ?? [] } : null
}

function agentNameOf(sessionId: string): string | null {
  const { sessionIndex, agentConfigs } = useAcpStore.getState()
  const configId = sessionIndex.find((e) => e.id === sessionId)?.agentConfigId
  return agentConfigs.find((c) => c.id === configId)?.name ?? null
}

export interface ConversationContexts {
  blocks: ContentBlock[]
  unavailable: ReadonlySet<string>
}

export async function resolveConversationContexts(
  refs: ReadonlyArray<{ title: string; sessionId: string }>
): Promise<ConversationContexts> {
  const blocks: ContentBlock[] = []
  const unavailable = new Set<string>()
  for (const { title, sessionId } of refs) {
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
      unavailable.add(sessionId)
      continue
    }
    const contextTitle = capContextFragment(title)
    const body = buildConversationContext({
      title: contextTitle,
      messages: transcript.messages,
      toolCalls: transcript.toolCalls,
      agentName: agentNameOf(sessionId)
    })
    blocks.push({ type: 'text', text: conversationEnvelope(sessionId, contextTitle, body) })
  }
  return { blocks, unavailable }
}
