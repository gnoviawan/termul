import type { SessionStatus } from '@/stores/acp-store'

export interface AgentChatAttentionInput {
  projectId: string
  sessionStatus: SessionStatus
  agentStatus: string | undefined
  pendingPermission: boolean
  pendingQuestion: boolean
  /** An entrance warm-up is not an Agent chat. */
  ephemeral: boolean
}

/**
 * A permission, a question, or a closed Session after the Agent process
 * stopped. A finished turn, including a turn that ended in an error while the
 * process is still the chat's process, is not Attention.
 */
export function agentChatNeedsAttention(input: AgentChatAttentionInput): boolean {
  if (input.ephemeral || input.projectId.length === 0) return false
  if (input.pendingPermission || input.pendingQuestion) return true
  if (input.sessionStatus === 'closed') return true
  if (input.agentStatus === 'disconnected') return true
  return false
}

export function attentionCountForProject(
  projectId: string,
  chats: readonly AgentChatAttentionInput[]
): number {
  return chats.filter((chat) => chat.projectId === projectId && agentChatNeedsAttention(chat))
    .length
}
