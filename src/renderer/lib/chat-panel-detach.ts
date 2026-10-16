/**
 * Panel detach rule (AD-13): a chat panel is detached only when it is in no
 * tab and its session is idle, debounced after paint.
 *
 * Watches the workspace store (every project's tree, active and parked). When
 * a session id leaves its last agent-chat tab it schedules a detach — double
 * `requestAnimationFrame`, then a short timer, cancelable — and at fire time
 * releases the session's payload pin (`unpinSessionPayload`) only if the
 * session is STILL in no tab and idle. A busy session is re-checked on the
 * next acp-store transition. A session that is in a tab (in ANY tree) or has
 * a turn in flight is never detached; chats in parked trees stay pinned.
 */

import { sessionTurnBusy, useAcpStore } from '@/stores/acp-store'
import type { AcpState } from '@/stores/acp-store/types'
import { getAgentChatSessionIdsInAllTrees, useWorkspaceStore } from '@/stores/workspace-store'
import { getPinnedSessionPayloadIds, unpinSessionPayload } from './acp-history-persistence'

/** Quiet time after paint before a tab-less session is detached. */
export const CHAT_PANEL_DETACH_DEBOUNCE_MS = 250

/** No active turn, queued prompt, pending permission/question, replay or launch. */
export function isChatSessionIdle(
  state: Pick<
    AcpState,
    'sessions' | 'promptQueues' | 'pendingPermissions' | 'pendingQuestions' | 'launchingSessionIds'
  >,
  sessionId: string
): boolean {
  const session = state.sessions[sessionId]
  if (sessionTurnBusy(session) || session?.replaying) return false
  if ((state.promptQueues[sessionId]?.length ?? 0) > 0) return false
  if (sessionId in state.launchingSessionIds) return false
  if (Object.values(state.pendingPermissions).some((p) => p.sessionId === sessionId)) return false
  if (Object.values(state.pendingQuestions).some((q) => q.sessionId === sessionId)) return false
  return true
}

/** Double `requestAnimationFrame` (after paint), then the debounce timer. */
function scheduleAfterPaint(run: () => void): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let frame1 = 0
  let frame2 = 0
  const afterFrames = (): void => {
    if (cancelled) return
    timer = setTimeout(() => {
      timer = null
      if (!cancelled) run()
    }, CHAT_PANEL_DETACH_DEBOUNCE_MS)
  }
  frame1 = requestAnimationFrame(() => {
    frame2 = requestAnimationFrame(afterFrames)
  })
  return () => {
    cancelled = true
    cancelAnimationFrame(frame1)
    cancelAnimationFrame(frame2)
    if (timer !== null) clearTimeout(timer)
  }
}

/** Start watching; returns the cleanup that cancels everything pending. */
export function startChatPanelDetach(): () => void {
  let inTabs = getAgentChatSessionIdsInAllTrees(useWorkspaceStore.getState())
  // One cancel per session: its pending debounce or its wait for idle.
  const pending = new Map<string, () => void>()

  const cancel = (sessionId: string): void => {
    pending.get(sessionId)?.()
    pending.delete(sessionId)
  }

  const attempt = (sessionId: string): void => {
    pending.delete(sessionId)
    if (getAgentChatSessionIdsInAllTrees(useWorkspaceStore.getState()).has(sessionId)) return
    if (isChatSessionIdle(useAcpStore.getState(), sessionId)) {
      unpinSessionPayload(sessionId)
      return
    }
    // Busy: re-check on the next transition that leaves it idle.
    const unsubscribe = useAcpStore.subscribe((state) => {
      if (!isChatSessionIdle(state, sessionId)) return
      unsubscribe()
      attempt(sessionId)
    })
    pending.set(sessionId, unsubscribe)
  }

  const schedule = (sessionId: string): void => {
    cancel(sessionId)
    pending.set(
      sessionId,
      scheduleAfterPaint(() => attempt(sessionId))
    )
  }

  // Pins taken before this watcher started (a hot reload, or a chat that left
  // its tab first) would otherwise never be released.
  for (const sessionId of getPinnedSessionPayloadIds()) {
    if (!inTabs.has(sessionId)) schedule(sessionId)
  }

  const unsubscribeWorkspace = useWorkspaceStore.subscribe((state, prev) => {
    if (state.root === prev.root && state.parkedTrees === prev.parkedTrees) return
    const next = getAgentChatSessionIdsInAllTrees(state)
    for (const sessionId of inTabs) {
      if (!next.has(sessionId)) schedule(sessionId)
    }
    // Back in a tab before the debounce (or while waiting for idle) fired.
    for (const sessionId of next) cancel(sessionId)
    inTabs = next
  })

  return () => {
    unsubscribeWorkspace()
    for (const cancelPending of pending.values()) cancelPending()
    pending.clear()
  }
}
