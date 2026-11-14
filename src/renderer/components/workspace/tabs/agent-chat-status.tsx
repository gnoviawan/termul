import { chatNeedsYou } from '@/lib/agent-chat-attention'
import { type AcpSession, isEphemeralAcpSession, useAcpStore } from '@/stores/acp-store'
import { useChatActivityStore } from '@/stores/chat-activity-store'
import { sessionTurnBusy } from '@/stores/prompt-queue-orchestration'

/**
 * Per-session status signals shared by the desktop `AgentChatTabInline`, the
 * Rail chat rows (`useChatLiveState`) and the mobile drawer rows. Working, the
 * pending prompts behind Needs you, and New activity come from the host's
 * `chat_activity` record, so a chat this renderer never opened shows the
 * same status as one it is driving. The desktop tab collapses them into a
 * single trailing slot (Needs you, then Working, then New activity); the Rail
 * and the drawer rows map them to one live state with `liveStateOf`.
 */
export interface AgentChatStatusSignals {
  /** This renderer's Session record, when it opened the chat. */
  session: AcpSession | undefined
  /**
   * A pending permission, question or elicitation (host), or, for a chat this
   * renderer opened, a disconnected Agent or a closed Session that cannot
   * resume by itself (`chatNeedsYou`).
   */
  needsAttention: boolean
  /**
   * The host has a prompt turn open or the agent working outside one, or this
   * renderer's live Session does (the composer's own state).
   */
  turnBusy: boolean
  /**
   * A turn end nobody has read (host), on a chat this renderer is not showing.
   * Survives a stopped (`closed`) or crashed chat until the chat is read.
   */
  unread: boolean
}

export function useAgentChatStatusSignals(sessionId: string): AgentChatStatusSignals {
  // `?.` guards: some suites mock the acp-store as a partial shape (see
  // `use-agent-chat-attention`). They are no-ops against the real store.
  const session = useAcpStore((s) => s.sessions?.[sessionId])
  const agentStatus = useAcpStore((s) => (session ? s.agentStatus?.[session.agentId] : undefined))
  const activity = useChatActivityStore((s) => s.sessions[sessionId])
  const viewing = useChatActivityStore((s) => s.viewing.includes(sessionId))
  // Warm-pool sessions are not chats.
  if (isEphemeralAcpSession(sessionId)) {
    return { session, needsAttention: false, turnBusy: false, unread: false }
  }
  // A live chat this renderer drives knows its turn before the host echoes it
  // back, so the row starts Working with the composer. A record that is not
  // live keeps whatever turn flags it last had, so only the host counts then.
  const localBusy = session?.status === 'active' && sessionTurnBusy(session)
  return {
    session,
    needsAttention: chatNeedsYou(activity, session, agentStatus),
    turnBusy: Boolean(activity?.busy) || localBusy,
    unread: Boolean(activity?.unread) && !viewing
  }
}
