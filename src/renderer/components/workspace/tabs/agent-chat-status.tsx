import { CircleDot } from '@/components/icons'
import { Spinner } from '@/components/ui/spinner'
import { agentChatNeedsAttention } from '@/lib/agent-chat-attention'
import { type AcpSession, isEphemeralAcpSession, useAcpStore } from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { sessionTurnBusy } from '@/stores/prompt-queue-orchestration'

/**
 * Per-session status signals shared by the desktop `AgentChatTabInline` and
 * the mobile drawer's Open chat rows, so both derive "needs you", "closing"
 * and "working" from one source. The desktop tab collapses them into a single
 * trailing slot (Closing, then Needs you, then Working, then New activity);
 * the drawer rows have room for every active status, so they use
 * `agentChatStatusSlots` and `AgentChatStatusGlyphs` below instead.
 */
export interface AgentChatStatusSignals {
  session: AcpSession | undefined
  /** Permission, question, or a closed/disconnected chat (`agentChatNeedsAttention`). */
  needsAttention: boolean
  /** A close is in flight (`useAgentChatLifetimeStore.closingSessionIds`). */
  closing: boolean
  /**
   * Only a live, non-ephemeral session counts: closed/error sessions can carry
   * stale openTurnId/activeTurn flags (e.g. a crashed-session retry) and
   * warm-pool sessions are not chats.
   */
  liveSession: boolean
  turnBusy: boolean
}

export function useAgentChatStatusSignals(sessionId: string): AgentChatStatusSignals {
  // `?.` / `?? {}` guards: some suites mock the acp-store as a partial shape
  // (see `use-agent-chat-attention`). They are no-ops against the real store.
  const session = useAcpStore((s) => s.sessions?.[sessionId])
  const agentStatus = useAcpStore((s) => (session ? s.agentStatus?.[session.agentId] : undefined))
  const pendingPermission = useAcpStore((s) =>
    Object.values(s.pendingPermissions ?? {}).some(
      (permission) => permission.sessionId === sessionId
    )
  )
  const pendingQuestion = useAcpStore((s) =>
    Object.values(s.pendingQuestions ?? {}).some((question) => question.sessionId === sessionId)
  )
  const closing = useAgentChatLifetimeStore((s) => Boolean(s.closingSessionIds[sessionId]))
  const ephemeral = session ? isEphemeralAcpSession(session.id) : false
  const needsAttention = session
    ? agentChatNeedsAttention({
        projectId: session.projectId,
        sessionStatus: session.status,
        agentStatus,
        pendingPermission,
        pendingQuestion,
        ephemeral
      })
    : false
  // The old lamp slot is now a turn-lifecycle cue: a live turn spins, and a
  // turn that finishes while this tab is not the pane's active tab leaves an
  // unread dot until the tab becomes active.
  const liveSession =
    session != null && !ephemeral && session.status !== 'closed' && session.status !== 'error'
  const turnBusy = liveSession && sessionTurnBusy(session)
  return { session, needsAttention, closing, liveSession, turnBusy }
}

export interface AgentChatStatusSlotsInput {
  closing: boolean
  needsAttention: boolean
  turnBusy: boolean
  liveSession: boolean
  unread: boolean
}

export interface AgentChatStatusSlots {
  showWorking: boolean
  showUnread: boolean
  /** Ordered Closing, Needs you, Working, New activity. */
  statuses: string[]
  /** `statuses.join(', ')`: feeds the aria-label suffix and any live region. */
  statusText: string
}

/**
 * Drawer-row slot priority: the Closing spinner wins, then the running
 * spinner, then the unread dot. Needs you shows alongside whichever slot is
 * active. (The desktop tab chrome has one trailing slot and pins Needs you
 * over Working and New activity instead; see `agent-chat-tab.tsx`.)
 */
export function agentChatStatusSlots({
  closing,
  needsAttention,
  turnBusy,
  liveSession,
  unread
}: AgentChatStatusSlotsInput): AgentChatStatusSlots {
  const showWorking = !closing && turnBusy
  const showUnread = liveSession && !closing && !turnBusy && unread
  const statuses: string[] = []
  if (closing) statuses.push('Closing')
  if (needsAttention) statuses.push('Needs you')
  if (showWorking) statuses.push('Working')
  if (showUnread) statuses.push('New activity')
  return { showWorking, showUnread, statuses, statusText: statuses.join(', ') }
}

interface AgentChatStatusGlyphsProps {
  closing: boolean
  needsAttention: boolean
  showWorking: boolean
  showUnread: boolean
}

/** The status glyphs (each with `sr-only` text) rendered in slot-priority order. */
export function AgentChatStatusGlyphs({
  closing,
  needsAttention,
  showWorking,
  showUnread
}: AgentChatStatusGlyphsProps): React.JSX.Element {
  return (
    <>
      {closing ? (
        <span
          className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground"
          title="Closing. This chat stops when the turn finishes."
        >
          <Spinner size={12} decorative />
          <span className="sr-only">Closing</span>
        </span>
      ) : null}
      {needsAttention ? (
        <span
          className="inline-flex size-3.5 shrink-0 items-center justify-center text-warning"
          title="Needs you"
        >
          <CircleDot size={12} aria-hidden />
          <span className="sr-only">Needs you</span>
        </span>
      ) : null}
      {showWorking ? (
        <span
          className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground"
          title="Working"
        >
          <Spinner size={12} decorative />
          <span className="sr-only">Working</span>
        </span>
      ) : null}
      {showUnread ? (
        <span
          className="inline-flex size-3.5 shrink-0 items-center justify-center"
          title="New activity"
        >
          <span className="h-2 w-2 rounded-full bg-primary-fill" aria-hidden />
          <span className="sr-only">New activity</span>
        </span>
      ) : null}
    </>
  )
}
