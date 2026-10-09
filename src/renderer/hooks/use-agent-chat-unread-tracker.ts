import { useLayoutEffect, useRef } from 'react'
import { useShallow } from 'zustand/shallow'
import { isEphemeralAcpSession, useAcpStore } from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'
import { sessionTurnBusy } from '@/stores/prompt-queue-orchestration'

/**
 * Sets "New activity" in `useAgentChatUnreadStore` when a live chat's turn
 * finishes while it is not the active chat, and clears it when the chat is
 * viewed (or is no longer a live chat).
 *
 * It lives at shell level (the mobile drawer mounts it) because the drawer's
 * Open rows are unmounted while the drawer is closed, so a row-local effect
 * would miss every turn that finishes behind a closed drawer. Only live,
 * non-ephemeral sessions are tracked: closed/error sessions can carry stale
 * turn flags and warm-pool sessions are not chats, so a turn that ends because
 * the session closed never banks a dot. `closing` wins the slot, so a turn
 * that ends during a close never banks one either.
 */
export function useAgentChatUnreadTracker(activeSessionId: string | null): void {
  // The `?? {}` guard keeps suites that mock the acp-store as a partial shape
  // working (see `use-agent-chat-attention`); it is a no-op on the real store.
  const busyBySession = useAcpStore(
    useShallow((state) => {
      const busy: Record<string, boolean> = {}
      for (const [sessionId, session] of Object.entries(state.sessions ?? {})) {
        if (session.status === 'closed' || session.status === 'error') continue
        if (isEphemeralAcpSession(sessionId)) continue
        busy[sessionId] = sessionTurnBusy(session)
      }
      return busy
    })
  )
  const closingSessionIds = useAgentChatLifetimeStore((state) => state.closingSessionIds)
  const previousBusy = useRef<Record<string, boolean>>({})

  // useLayoutEffect banks the flag before paint so the finish commit swaps the
  // spinner for the dot with no one-frame gap (same reasoning as the desktop tab).
  useLayoutEffect(() => {
    const previous = previousBusy.current
    previousBusy.current = busyBySession
    const { markUnread, clearUnread } = useAgentChatUnreadStore.getState()
    for (const [sessionId, busy] of Object.entries(busyBySession)) {
      const turnFinished = previous[sessionId] === true && !busy
      if (turnFinished && sessionId !== activeSessionId && !closingSessionIds[sessionId]) {
        markUnread(sessionId)
      }
    }
    if (activeSessionId) clearUnread(activeSessionId)
    for (const sessionId of Object.keys(useAgentChatUnreadStore.getState().unread)) {
      if (!(sessionId in busyBySession)) clearUnread(sessionId)
    }
  }, [busyBySession, activeSessionId, closingSessionIds])
}
