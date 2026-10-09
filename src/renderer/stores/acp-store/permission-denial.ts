/**
 * Denied-by-disconnect detection (L-09).
 *
 * On termul-server a pending permission is denied when the client that should
 * answer it disconnects and does not return within the reconnect grace. The
 * server emits no event for that, so the renderer sees only the entry leaving
 * `pendingPermissions` (typically with the replayed `prompt_complete`). The
 * signal is therefore inferential: a permission that was pending at a transport
 * loss, then left the store without a user action while its session is still
 * alive, is treated as denied.
 *
 * Detection lives here, on the store, not in a component: the notice must
 * reach a chat whose pane is hidden or unmounted and feed the shell announcer.
 * Tauri IPC never sets `transportReconnecting`, so desktop never gets here.
 *
 * Known limits, out of scope: a page reload (no memory of the loss), the
 * server's 60s per-ticket timeout denial with no loss, and a stale prompt that
 * stays on screen until its turn ends.
 */

import type { StoreApi } from 'zustand'
import type { SessionId } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import { permissionToolTitle } from '@/lib/permission-denial'
import type { AcpState, PermissionDenialNotice } from './types'

/** A permission that was pending when the transport dropped. */
export interface TrackedPermission {
  sessionId: SessionId
  tool: string
}

/** Pending permissions copied at a transport loss, keyed by request id. */
const trackedAtLoss = new Map<string, TrackedPermission>()

/**
 * The user (or a turn-level user action) is answering this request: it is no
 * longer a candidate for a denial. Returns the entry so a failed response can
 * `retrackPermission` it.
 */
export function forgetTrackedPermission(requestId: string): TrackedPermission | undefined {
  const entry = trackedAtLoss.get(requestId)
  trackedAtLoss.delete(requestId)
  return entry
}

/** Put an entry back after a failed response restored its `pendingPermissions` row. */
export function retrackPermission(requestId: string, entry: TrackedPermission): void {
  trackedAtLoss.set(requestId, entry)
}

/**
 * Stop or Send now: every tracked request of the session leaves with the user's
 * cancel. Returns what it removed so a cancel that fails can hand it to
 * `retrackStillPending`.
 */
export function forgetTrackedPermissionsForSession(
  sessionId: SessionId
): Array<[string, TrackedPermission]> {
  const forgotten: Array<[string, TrackedPermission]> = []
  for (const [requestId, entry] of trackedAtLoss) {
    if (entry.sessionId !== sessionId) continue
    trackedAtLoss.delete(requestId)
    forgotten.push([requestId, entry])
  }
  return forgotten
}

/**
 * A cancel that failed abandoned nothing: track again the requests it forgot
 * that are still pending. One that left the store meanwhile stays forgotten, so
 * a stale entry cannot raise a notice on a later, unrelated change.
 */
export function retrackStillPending(
  forgotten: ReadonlyArray<[string, TrackedPermission]>,
  pending: Readonly<Record<string, unknown>>
): void {
  for (const [requestId, entry] of forgotten) {
    if (pending[requestId]) trackedAtLoss.set(requestId, entry)
  }
}

/** Test-only: empty the module-level map. */
export function _resetPermissionDenialTrackingForTesting(): void {
  trackedAtLoss.clear()
}

/** Test-only: the request ids currently tracked. */
export function _trackedPermissionIdsForTesting(): string[] {
  return [...trackedAtLoss.keys()]
}

function evaluate(store: StoreApi<AcpState>, state: AcpState, prev: AcpState): void {
  // 1. A transport loss: remember what is pending right now. A request that
  // arrives after the loss was never at risk and is not tracked.
  if (state.transportReconnecting && !prev.transportReconnecting) {
    for (const [requestId, permission] of Object.entries(state.pendingPermissions ?? {})) {
      trackedAtLoss.set(requestId, {
        sessionId: permission.sessionId,
        tool: permissionToolTitle(permission.toolCall)
      })
    }
  }

  // The store writes on every streamed flush, so copy the notices only when one
  // actually changes.
  const current = state.permissionDenialNotices ?? {}
  let next = current
  const edit = (): Record<SessionId, PermissionDenialNotice> => {
    if (next === current) next = { ...current }
    return next
  }

  // 3. A notice ends with its session or when the session's next turn starts.
  if (state.sessions !== prev.sessions) {
    for (const sessionId of Object.keys(current)) {
      const session = state.sessions[sessionId]
      const nextTurnStarted =
        session?.activeTurn === true && prev.sessions[sessionId]?.activeTurn === false
      if (!session || nextTurnStarted) delete edit()[sessionId]
    }
  }

  // 2. A tracked request that left without the user: raise the notice unless
  // its session is gone, closed or errored. The first vanished id of a pass
  // wins; a later pass replaces an older notice (it is a newer denial).
  if (state.pendingPermissions !== prev.pendingPermissions && trackedAtLoss.size > 0) {
    const raised = new Set<SessionId>()
    for (const [requestId, tracked] of [...trackedAtLoss]) {
      if (state.pendingPermissions?.[requestId]) continue
      trackedAtLoss.delete(requestId)
      const session = state.sessions[tracked.sessionId]
      if (!session || session.status === 'closed' || session.status === 'error') continue
      if (raised.has(tracked.sessionId)) continue
      raised.add(tracked.sessionId)
      edit()[tracked.sessionId] = { requestId, tool: tracked.tool }
      // Ids only: the tool text can carry commands or paths.
      void logFrontendError({
        level: 'info',
        source: 'acp.permissionDeniedByDisconnect',
        message: `Permission request ${requestId} for session ${tracked.sessionId} left unanswered after a transport loss`
      })
    }
  }

  if (next !== current) store.setState({ permissionDenialNotices: next })
}

/**
 * Subscribe to the store and keep `permissionDenialNotices` in step. Returns
 * the unsubscribe; it also empties the tracking map.
 */
export function attachPermissionDenialTracking(store: StoreApi<AcpState>): () => void {
  const unsubscribe = store.subscribe((state, prev) => {
    try {
      evaluate(store, state, prev)
    } catch (error) {
      void logFrontendError({
        level: 'warn',
        source: 'acp.permissionDenialTracking',
        message: `Permission denial tracking failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        stack: error instanceof Error ? error.stack : undefined
      })
    }
  })
  return () => {
    unsubscribe()
    trackedAtLoss.clear()
  }
}
