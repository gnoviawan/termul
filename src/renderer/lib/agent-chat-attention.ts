import { CODEX_CLI_SIGNED_OUT_MESSAGE } from '@/lib/agents/codex-cli-auth'
import type { SessionStatus } from '@/stores/acp-store'
import { isResumeFailureError } from '@/stores/acp-store/helpers'

export interface AgentChatAttentionInput {
  projectId: string
  sessionStatus: SessionStatus
  agentStatus: string | undefined
  pendingPermission: boolean
  pendingQuestion: boolean
  pendingElicitation: boolean
  /** The Session's `lastError`. Decides whether a `closed` Session can resume by itself. */
  lastError: string | null
  /** An entrance warm-up is not an Agent chat. */
  ephemeral: boolean
}

/**
 * A `closed` Session that cannot resume by itself: its resume failed, or Codex
 * signed out. A cleanly stopped chat (idle reaper, Closing) resumes when the
 * user types, so it does not need the user.
 */
function closedSessionCannotResume(lastError: string | null): boolean {
  return isResumeFailureError(lastError) || lastError === CODEX_CLI_SIGNED_OUT_MESSAGE
}

/**
 * A permission, a question, an elicitation, a disconnected Agent, or a closed
 * Session that cannot resume by itself. A cleanly stopped chat is not
 * Attention, and neither is a finished turn, including a turn that ended in an
 * error while the process is still the chat's process. An unanswered
 * elicitation blocks the agent exactly as a question does.
 */
export function agentChatNeedsAttention(input: AgentChatAttentionInput): boolean {
  if (input.ephemeral || input.projectId.length === 0) return false
  if (input.pendingPermission || input.pendingQuestion || input.pendingElicitation) return true
  if (input.sessionStatus === 'closed' && closedSessionCannotResume(input.lastError)) return true
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
