import { useEffect, useMemo, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { chatForeignToProject } from '@/lib/acp-session-ownership'
import { logFrontendError } from '@/lib/log-api'
import { clearChatRoute } from '@/lib/router-navigate'
import { clearChatClosedOnRoute, isChatClosedOnRoute } from '@/lib/web-tab-session'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { agentChatTabId, findPaneContainingTab, useWorkspaceStore } from '@/stores/workspace-store'

/**
 * Null-rendering component that triggers `openHistorySession` when the URL
 * contains `#/c/<sessionId>`. This is the refresh-survival mechanism for the
 * active chat — on reload the session restores from the URL before the
 * workspace manifest or session index loads, avoiding the "no active chat"
 * race.
 *
 * Retries up to 5 times with a 500ms delay because the server's history
 * persistence is async — a session that was just active may not be in the
 * persisted store immediately after a refresh.
 *
 * After restoring, calls `addAgentChatTab` to ensure the session has a
 * visible tab in the workspace (the manifest may not have restored it).
 *
 * Subscribes to the workspace pane-tree `root`: the dep fires on EVERY root
 * identity change (boot-restore swap, but also any tab add/close/select),
 * so the re-delegation is gated in two windows.
 *
 * BOOT WINDOW (mount → first real user interaction): `openHistorySession`
 * is async — the session record and the chat tab land only after its fetch
 * resolves — while terminal restore (useTerminalRestore's live-PTY path)
 * activates the persisted terminal tab in the SAME pane, machine-driven,
 * before the user has touched anything. Until the first pointerdown or
 * keydown (captured once, flagged in a ref), the route re-delegates on
 * EVERY root change, same pane or not: the boot machinery must not win
 * over the route.
 *
 * INTERACTED WINDOW (after the first interaction): the chat tab's PANE ID
 * is the discriminator between tree rebuilds and user intent — a wholesale
 * tree replacement (loadProjectWorkspace / resetLayout /
 * deserializePaneTree) builds all-new pane ids, while user mutations
 * (setActiveTab, addTabToPane, closeTab) preserve pane ids via updateLeaf.
 * - Re-activate when the chat tab is ABSENT from the tree, or when it is
 *   present-but-inactive in a pane the effect last saw under a DIFFERENT id
 *   — both mean the tree was rebuilt (boot restore: the manifest/legacy
 *   path replaced the tree after the mount delegation, and
 *   reattachOpenAgentChats re-inserted the chat tab without activating it
 *   so the manifest's terminal stayed active).
 * - Never when the tab is present-but-inactive in the SAME pane — that is
 *   user intent (selecting a sibling tab, creating a terminal in the chat's
 *   pane), not a race to win.
 *
 * Independent of both windows:
 * - Never re-open a session whose chat the user closed while this route
 *   stayed current: closing only releases the chat (lifetime store +
 *   session close) without clearing the route. The signal is the
 *   synchronous closed-on-route mark set by `requestCloseAgentChat`
 *   (`web-tab-session.ts`) — it survives a close that races the mount-time
 *   open, unlike a store-record heuristic. The first effect run (mount /
 *   route change) is exempt — that is the reload path itself. A route
 *   target change clears the mark so navigating to a different chat (even
 *   a previously-closed one) re-opens it.
 *
 * - Never insert a chat KNOWN to belong to another project than the active
 *   one (stale route from Back/bookmark after a project switch): the pane
 *   tree is shared across projects, so the insert would leak that chat into
 *   this project's workspace. The route is cleared instead and the user
 *   stays on the active project. Unknown ownership is fail-open.
 *
 * Loop-safe: a gated re-activation runs the store's idempotent
 * addAgentChatTab (no-op when the tab is already active+focused), so the
 * follow-up run sees the same state and stops delegating (swap →
 * activate → settle).
 */
/**
 * Whether the routed chat is known-foreign to the active project; if so,
 * clears the route (instead of inserting the tab) and logs the skip.
 */
function rejectForeignRouteChat(sessionId: string): boolean {
  const projectId = useProjectStore.getState().activeProjectId
  if (!chatForeignToProject(sessionId, projectId, useAcpStore.getState())) return false
  void logFrontendError({
    level: 'warn',
    source: 'ChatRoute',
    message: `Skipped foreign-project chat route (session ${sessionId}) on project ${projectId}`
  })
  clearChatRoute(sessionId)
  return true
}

export function ChatRoute(): null {
  const location = useLocation()
  const openHistorySession = useAcpStore((s) => s.openHistorySession)
  const root = useWorkspaceStore((s) => s.root)
  const isFirstRunRef = useRef(true)
  const chatPaneIdRef = useRef<string | null>(null)
  const hasInteractedRef = useRef(false)
  const lastSessionIdRef = useRef<string | null>(null)

  const sessionId = useMemo(() => {
    const match = location.pathname.match(/^\/c\/(.+)$/)
    return match?.[1] ?? null
  }, [location.pathname])

  // Route target changed: reset every per-route signal so the new chat gets
  // a fresh mount-equivalent run (P1 — a previously-closed history session
  // navigated to from another chat must re-open, not inherit the old
  // route's closed/suppression state). The closed-on-route mark belongs to
  // the OLD session: clear it so a later return to that chat re-opens.
  if (lastSessionIdRef.current !== sessionId) {
    if (lastSessionIdRef.current) clearChatClosedOnRoute(lastSessionIdRef.current)
    lastSessionIdRef.current = sessionId
    isFirstRunRef.current = true
    chatPaneIdRef.current = null
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: root intentionally retriggers the effect; the gate below is about WHEN to re-delegate, not a duplicate of the store's activation no-op predicate
  useEffect(() => {
    if (!sessionId) return
    const firstRun = isFirstRunRef.current
    isFirstRunRef.current = false
    const tabId = agentChatTabId(sessionId)
    // Boot window: from mount until the first real user interaction, boot
    // machinery (terminal restore's same-pane steal racing the async open)
    // must not outrank the route — the pane-id gate below stays disarmed.
    const markInteracted = (): void => {
      hasInteractedRef.current = true
    }
    if (!hasInteractedRef.current) {
      window.addEventListener('pointerdown', markInteracted, { once: true })
      window.addEventListener('keydown', markInteracted, { once: true })
    }

    const chatPane = findPaneContainingTab(useWorkspaceStore.getState().root, tabId)
    if (!firstRun && chatPane && hasInteractedRef.current) {
      // Same pane as the last effect run = a user mutation (select/add/
      // close keep pane ids via updateLeaf): leave the tree alone. A
      // different pane id = the tree was rebuilt under the route (boot
      // restore's wholesale swap) and the re-inserted chat tab lost its
      // activation — re-delegate so the route wins.
      if (chatPane.id === chatPaneIdRef.current) return
    }
    chatPaneIdRef.current = chatPane?.id ?? null
    const recordPaneAfterDelegation = (): void => {
      chatPaneIdRef.current =
        findPaneContainingTab(useWorkspaceStore.getState().root, tabId)?.id ?? null
    }

    const existing = useAcpStore.getState().sessions[sessionId]
    if (!firstRun && isChatClosedOnRoute(sessionId)) {
      // The user closed this chat while its route stayed current: closing
      // releases the chat and removes the tab without clearing the route,
      // so the route must not resurrect it. The signal is the synchronous
      // closed-on-route mark set by requestCloseAgentChat — independent of
      // acp-store timing, so a close that races the mount-time
      // openHistorySession (still in flight, record still 'closed' mid-open)
      // is still caught. The first run (mount / route change) is exempt —
      // that is the reload path itself.
      return
    }
    if (rejectForeignRouteChat(sessionId)) return
    if (existing && existing.status !== 'closed') {
      // Multi-project perf: idempotency lives in `addAgentChatTab` (the
      // single source of truth) — it no-ops when the chat tab already exists
      // and is its pane's active, focused tab, so a route re-entry costs one
      // getState walk, not a second pane-tree rebuild.
      useWorkspaceStore.getState().addAgentChatTab(sessionId)
      // The chat is open on this route again — a closed-on-route mark from
      // a previous visit (the module-level mark survives component unmount)
      // must not suppress later re-runs. A future close re-marks it.
      clearChatClosedOnRoute(sessionId)
      recordPaneAfterDelegation()
      return
    }
    let cancelled = false
    let attempt = 0
    const maxAttempts = 5
    const tryOpen = async (): Promise<void> => {
      if (cancelled) return
      attempt++
      try {
        await openHistorySession(sessionId)
        // The opened record may only now reveal the owner (index not loaded
        // before the open).
        if (!cancelled && !rejectForeignRouteChat(sessionId)) {
          useWorkspaceStore.getState().addAgentChatTab(sessionId)
          // Same as the live branch: the (re-)opened chat clears any stale
          // closed-on-route mark from a previous visit.
          clearChatClosedOnRoute(sessionId)
          recordPaneAfterDelegation()
        }
      } catch {
        if (cancelled || attempt >= maxAttempts) return
        setTimeout(tryOpen, 500)
      }
    }
    void tryOpen()
    return () => {
      cancelled = true
      window.removeEventListener('pointerdown', markInteracted)
      window.removeEventListener('keydown', markInteracted)
    }
  }, [sessionId, openHistorySession, root])

  return null
}
