/**
 * Renderer facade for the host's shared chat last-read markers. Every carrier
 * speaks `/ws` (the desktop over its IPC Channel), so one client serves the
 * desktop, a shared-live phone and a `termul-server` browser alike. The host
 * compares the marker with each chat's newest turn end and publishes the
 * result as `unread` on the `chat_activity` watch.
 */
import { type AcpTransport, getAcpTransport } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { isAfter, type LogPoint } from '@/lib/log-point'
import { useChatActivityStore } from '@/stores/chat-activity-store'

const SOURCE = 'chat-read-sync'

/** The wait before each resend of a point the host failed to take. */
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const

/** The newest point sent per session: in flight, waiting for a resend, or answered. */
const sent = new Map<string, LogPoint>()

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Tell the host this surface read `sessionId` up to `read`. A point already
 * sent for the session, in flight, waiting for a resend or answered, is not
 * sent again. A failure is logged and the point resent after a delay, a few
 * times, unless a newer point was sent or the host no longer shows the chat
 * unread; once the resends run out, the next call sends it again.
 */
export function markChatRead(
  sessionId: string,
  read: LogPoint,
  transport: AcpTransport = getAcpTransport()
): void {
  if (!transport.markChatRead || !isAfter(read, sent.get(sessionId))) return
  sent.set(sessionId, read)
  send(sessionId, read, transport.markChatRead.bind(transport), 0)
}

function send(
  sessionId: string,
  read: LogPoint,
  mark: NonNullable<AcpTransport['markChatRead']>,
  attempt: number
): void {
  mark(sessionId, read.seq, read.logEpoch).catch((error: unknown) => {
    void logFrontendError({
      level: 'warn',
      source: SOURCE,
      message: `mark_chat_read failed for a chat at seq ${read.seq}: ${describe(error)}`
    })
    if (attempt === RETRY_DELAYS_MS.length) {
      if (sent.get(sessionId) === read) sent.delete(sessionId)
      return
    }
    setTimeout(() => {
      if (sent.get(sessionId) !== read) return
      if (!useChatActivityStore.getState().sessions[sessionId]?.unread) {
        sent.delete(sessionId)
        return
      }
      send(sessionId, read, mark, attempt + 1)
    }, RETRY_DELAYS_MS[attempt])
  })
}
