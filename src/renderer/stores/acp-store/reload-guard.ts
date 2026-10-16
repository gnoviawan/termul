import type { SessionId } from '@/lib/acp-api'

/**
 * Chats whose old agent process is being released on purpose.
 * `_onSessionClosed` must not cancel the reopen that follows, and must not
 * drop the transcript the open chat is still showing.
 */
export const reloadInFlight = new Set<SessionId>()
