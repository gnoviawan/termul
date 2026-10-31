import type { PermissionRequestEvent } from '@/lib/acp-api'

/**
 * Receives the host's still-pending approvals of one session, from a
 * `subscribe` or `recover_session_snapshot` reply. The list is authoritative:
 * an approval of the session that is not in it was answered or released.
 */
export type PendingPermissionsHandler = (
  sessionId: string,
  requests: PermissionRequestEvent[]
) => void

function isPermissionRequest(value: unknown, sessionId: string): value is PermissionRequestEvent {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<PermissionRequestEvent>
  return (
    typeof request.requestId === 'string' &&
    request.requestId.length > 0 &&
    request.sessionId === sessionId &&
    typeof request.agentId === 'string' &&
    Array.isArray(request.options)
  )
}

/**
 * The reply's `pendingPermissions` for `sessionId`, or `null` when the host
 * sent no list (a host without approval tickets, or one that predates it).
 * Malformed entries are skipped.
 */
export function readPendingPermissions(
  sessionId: string,
  reply: unknown
): PermissionRequestEvent[] | null {
  if (!reply || typeof reply !== 'object') return null
  const list = (reply as { pendingPermissions?: unknown }).pendingPermissions
  if (!Array.isArray(list)) return null
  return list.filter((value): value is PermissionRequestEvent =>
    isPermissionRequest(value, sessionId)
  )
}

/**
 * Host consent tickets (`host:<uuid>`, `HOST_TICKET_PREFIX` in
 * `browser-consent-api.ts`, which imports this transport) ride
 * `permission_request` too but are never in the pending list.
 */
const HOST_TICKET_PREFIX = 'host:'

function isHostTicket(payload: unknown): boolean {
  const requestId = (payload as { requestId?: unknown } | null)?.requestId
  return typeof requestId === 'string' && requestId.startsWith(HOST_TICKET_PREFIX)
}

/**
 * Per session, the log head an authoritative pending list was taken at. A
 * `permission_request` at or below it is replay the list already settled:
 * still pending means it is in the list, otherwise it was answered and must
 * not come back. Events above the head are live and always delivered.
 */
export class PendingPermissionCoverage {
  private readonly heads = new Map<string, number>()

  /** Record a reply: with a list, its head covers replay; without one, nothing does. */
  note(sessionId: string, headSeq: number | undefined, hasList: boolean): void {
    if (hasList && typeof headSeq === 'number') this.heads.set(sessionId, headSeq)
    else this.heads.delete(sessionId)
  }

  covers(sessionId: string, evt: { type: string; seq: number; payload?: unknown }): boolean {
    if (evt.type !== 'permission_request' || isHostTicket(evt.payload)) return false
    const head = this.heads.get(sessionId)
    return head !== undefined && evt.seq <= head
  }

  forget(sessionId: string): void {
    this.heads.delete(sessionId)
  }
}
