import { agentChatNeedsAttention } from '@/lib/agent-chat-attention'
import { isEphemeralAcpSession, useAcpStore } from '@/stores/acp-store'
import { useAgentChatProjectSignals } from './use-agent-chat-attention'

/**
 * Chats in the active project that need the user, excluding the chat on screen.
 * Reads the shared `attentionCounts` and subtracts the active chat when it is
 * counted there, so the mobile header pill never reports the chat the user is
 * already looking at. The active chat is judged with the same inputs the signals
 * hook uses: session status, its agent's status, a pending permission,
 * question or elicitation for that session, and the ephemeral flag.
 */
export function useMobileAttentionCount(
  activeProjectId: string | undefined,
  activeSessionId: string | null
): number {
  const { attentionCounts } = useAgentChatProjectSignals()
  const activeChatNeedsAttention = useAcpStore((state) => {
    if (!activeProjectId || !activeSessionId) return false
    const session = state.sessions?.[activeSessionId]
    if (!session || session.projectId !== activeProjectId) return false
    return agentChatNeedsAttention({
      projectId: session.projectId,
      sessionStatus: session.status,
      agentStatus: state.agentStatus?.[session.agentId],
      pendingPermission: Object.values(state.pendingPermissions ?? {}).some(
        (item) => item.sessionId === activeSessionId
      ),
      pendingQuestion: Object.values(state.pendingQuestions ?? {}).some(
        (item) => item.sessionId === activeSessionId
      ),
      pendingElicitation: Object.values(state.pendingElicitations ?? {}).some(
        (item) => item.sessionId === activeSessionId
      ),
      ephemeral: isEphemeralAcpSession(activeSessionId)
    })
  })
  if (!activeProjectId) return 0
  const counted = attentionCounts[activeProjectId] ?? 0
  return Math.max(0, counted - (activeChatNeedsAttention ? 1 : 0))
}
