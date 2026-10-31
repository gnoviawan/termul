/**
 * Issue #1595: install the host's still-pending approvals of a session after a
 * (re)subscribe. A `permission_request` is not in the durable log, so a client
 * that reconnects into a snapshot, or with a cursor past the request, would
 * otherwise never render the approval again while the turn waits on it.
 *
 * The host list is authoritative for the session: a listed request missing
 * from the store is added, and a stored one the host no longer lists (answered
 * from another client, or released) is dropped.
 */

import type { PermissionRequestEvent, SessionId } from '@/lib/acp-api'
import { logFrontendError } from '@/lib/log-api'
import type { AcpState } from './types'

/**
 * Request ids whose answer is on its way to the host. The store drops a
 * request optimistically when it is answered; a pending list taken before the
 * host processed that answer must not bring it back.
 */
const answeringPermissions = new Set<string>()

export function noteAnsweringPermission(requestId: string): void {
  answeringPermissions.add(requestId)
}

export function forgetAnsweringPermission(requestId: string): void {
  answeringPermissions.delete(requestId)
}

type StoreGet = () => AcpState
type StoreSet = (fn: (state: AcpState) => Partial<AcpState>) => void

export function syncPendingPermissions(
  get: StoreGet,
  set: StoreSet,
  sessionId: SessionId,
  requests: readonly PermissionRequestEvent[]
): void {
  const listed = new Set(requests.map((request) => request.requestId))
  let dropped = 0
  set((state) => {
    const stale = Object.values(state.pendingPermissions).filter(
      (pending) => pending.sessionId === sessionId && !listed.has(pending.requestId)
    )
    if (stale.length === 0) return {}
    dropped = stale.length
    const pendingPermissions = { ...state.pendingPermissions }
    for (const pending of stale) delete pendingPermissions[pending.requestId]
    return { pendingPermissions }
  })
  if (dropped > 0) {
    void logFrontendError({
      level: 'info',
      source: 'acp.pendingPermissions',
      message: `Session ${sessionId} dropped ${dropped} approval(s) the host no longer holds`
    })
  }
  for (const request of requests) {
    if (answeringPermissions.has(request.requestId)) continue
    // No event seq: the host list is current, so the history watermark must
    // not read it as already covered. An existing entry is kept as is.
    get()._onPermissionRequest(request)
  }
}
