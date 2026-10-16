/**
 * Renderer facade for the host's shared chat last-read markers. Every carrier
 * speaks `/ws` (the desktop over its IPC Channel), so one client serves the
 * desktop, a shared-live phone and a `termul-server` browser alike.
 */
import type { ChatReadsWatchDelta, ChatReadsWatchState } from '@shared/types/web-protocol.types'
import { type AcpTransport, getAcpTransport } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'

const SOURCE = 'chat-read-sync'

const unansweredSeq = new Map<string, number>()

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Record that this renderer has seen the turn end `seq` of `sessionId`. The
 * acp-store calls it for every `prompt_complete` it receives, live, replayed or
 * recovered from a snapshot, before the turn end is applied.
 */
export function noteTurnEndSeq(sessionId: string, seq: number | undefined): void {
  if (!sessionId || typeof seq !== 'number' || seq <= 0) return
  useAgentChatUnreadStore.getState().noteTurnEnd(sessionId, seq)
}

/** Start mirroring the host's read markers. Returns the stop. */
export function startChatReadSync(transport: AcpTransport = getAcpTransport()): () => void {
  const store = useAgentChatUnreadStore.getState
  const offMarks = transport.watches?.subscribe<ChatReadsWatchState, ChatReadsWatchDelta>(
    'chat_reads',
    {
      onState: (state) => store().setReadMarks(state?.marks ?? {}),
      onDelta: (delta) => {
        if (delta?.sessionId && typeof delta.seq === 'number') {
          store().setReadMark(delta.sessionId, delta.seq)
        }
      },
      onRefused: (error) => {
        void logFrontendError({
          level: 'warn',
          source: SOURCE,
          message: `chat_reads watch refused; reads on other surfaces will not clear dots here: ${describe(error)}`
        })
      }
    }
  )
  return () => offMarks?.()
}

/**
 * Tell the host this surface read `sessionId` up to `seq`. A seq already in
 * flight for the session is not sent again; a failure is logged and lets the
 * next call retry.
 */
export function markChatRead(
  sessionId: string,
  seq: number,
  transport: AcpTransport = getAcpTransport()
): void {
  if (!transport.markChatRead || (unansweredSeq.get(sessionId) ?? 0) >= seq) return
  unansweredSeq.set(sessionId, seq)
  const settle = () => {
    if (unansweredSeq.get(sessionId) === seq) unansweredSeq.delete(sessionId)
  }
  transport.markChatRead(sessionId, seq).then(
    (mark) => {
      settle()
      // Replies race the watch deltas, so a reply only ever raises the marker.
      const store = useAgentChatUnreadStore.getState()
      if (mark.seq > (store.sharedReadSeq[mark.sessionId] ?? 0)) {
        store.setReadMark(mark.sessionId, mark.seq)
      }
    },
    (error: unknown) => {
      settle()
      void logFrontendError({
        level: 'warn',
        source: SOURCE,
        message: `mark_chat_read failed for a chat at seq ${seq}: ${describe(error)}`
      })
    }
  )
}
