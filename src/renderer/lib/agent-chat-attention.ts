import type { SessionStatus } from '@/stores/acp-store'

export interface AgentChatAttentionInput {
  projectId: string
  sessionStatus: SessionStatus
  agentStatus: string | undefined
  pendingPermission: boolean
  pendingQuestion: boolean
  pendingElicitation: boolean
  /** An entrance warm-up is not an Agent chat. */
  ephemeral: boolean
}

/**
 * A permission, a question, an elicitation, or a closed Session after the
 * Agent process stopped. A finished turn, including a turn that ended in an
 * error while the process is still the chat's process, is not Attention. An
 * unanswered elicitation blocks the agent exactly as a question does.
 */
export function agentChatNeedsAttention(input: AgentChatAttentionInput): boolean {
  if (input.ephemeral || input.projectId.length === 0) return false
  if (input.pendingPermission || input.pendingQuestion || input.pendingElicitation) return true
  if (input.sessionStatus === 'closed') return true
  if (input.agentStatus === 'disconnected') return true
  return false
}

/** A connected Agent chat with no turn in progress. The activity spinner covers a live turn. */
export function agentChatIsRunning(input: {
  projectId: string
  sessionStatus: SessionStatus
  agentStatus: string | undefined
  activeTurn: boolean
  ephemeral: boolean
}): boolean {
  if (input.ephemeral || input.projectId.length === 0) return false
  if (input.activeTurn) return false
  if (input.sessionStatus === 'closed' || input.sessionStatus === 'error') return false
  return input.agentStatus === 'connected'
}

export function needsYouLabel(count: number): string {
  return count === 1 ? '1 needs you' : `${count} need you`
}

export function attentionCountForProject(
  projectId: string,
  chats: readonly AgentChatAttentionInput[]
): number {
  return chats.filter((chat) => chat.projectId === projectId && agentChatNeedsAttention(chat))
    .length
}
