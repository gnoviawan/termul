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

const SOURCE = 'chat-read-sync'

const unanswered = new Map<string, LogPoint>()

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Tell the host this surface read `sessionId` up to `read`. A point already in
 * flight for the session is not sent again; a failure is logged and lets the
 * next call retry.
 */
export function markChatRead(
  sessionId: string,
  read: LogPoint,
  transport: AcpTransport = getAcpTransport()
): void {
  if (!transport.markChatRead || !isAfter(read, unanswered.get(sessionId))) return
  unanswered.set(sessionId, read)
  const settle = () => {
    if (unanswered.get(sessionId) === read) unanswered.delete(sessionId)
  }
  transport.markChatRead(sessionId, read.seq, read.logEpoch).then(settle, (error: unknown) => {
    settle()
    void logFrontendError({
      level: 'warn',
      source: SOURCE,
      message: `mark_chat_read failed for a chat at seq ${read.seq}: ${describe(error)}`
    })
  })
}
