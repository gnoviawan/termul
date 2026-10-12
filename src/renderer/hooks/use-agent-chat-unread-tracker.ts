import { useLayoutEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/shallow'
import { isEphemeralAcpSession, useAcpStore } from '@/stores/acp-store'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'
import { sessionTurnBusy } from '@/stores/prompt-queue-orchestration'

/**
 * Sets "Done" ("New activity") in `useAgentChatUnreadStore` when a live chat's
 * turn finishes (or is cancelled) while it is not any pane's active tab, and
 * clears it when the chat becomes an active tab. `activeSessionIds` is every
 * pane's active-tab chat session id.
 *
 * It is mounted exactly once per renderer, at shell level
 * (`useShellUnreadTracker`, from `WorkspaceLayout`), because chat tabs and
 * Recents rows unmount (closed drawer, inactive tab, project switch) while a
 * turn finishes. A flag never clears because its session left the live set or
 * the project switched; it clears only on view here or on deletion
 * (`deleteHistorySession`). Only live, non-ephemeral sessions are tracked:
 * closed/error sessions can carry stale turn flags and warm-pool sessions are
 * not chats, so a turn that ends because the session closed never banks a dot.
 */
export function useAgentChatUnreadTracker(activeSessionIds: readonly string[]): void {
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
  const previousBusy = useRef<Record<string, boolean>>({})

  // Callers pass a fresh array every render; a joined key keeps the effect from
  // re-running unless the set of ids actually changed.
  const activeKey = activeSessionIds.join('\u0000')
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeKey is the stable identity of activeSessionIds
  const activeSet = useMemo(() => new Set(activeSessionIds), [activeKey])

  // useLayoutEffect banks the flag before paint so the finish commit swaps the
  // spinner for the dot with no one-frame gap.
  useLayoutEffect(() => {
    const previous = previousBusy.current
    previousBusy.current = busyBySession
    const { markUnread, clearUnread } = useAgentChatUnreadStore.getState()
    for (const [sessionId, busy] of Object.entries(busyBySession)) {
      const turnFinished = previous[sessionId] === true && !busy
      if (turnFinished && !activeSet.has(sessionId)) {
        markUnread(sessionId)
      }
    }
    for (const sessionId of activeSet) clearUnread(sessionId)
  }, [busyBySession, activeSet])
}
