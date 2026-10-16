import { create } from 'zustand'

interface AgentChatUnreadState {
  /** Sessions whose turn finished while they were not the active chat ("New activity"). */
  unread: Record<string, true>
  /**
   * Per dot, the `seenTurnEndSeq` when its newest turn started. A read elsewhere
   * can clear the dot only once a turn end newer than this was seen here.
   */
  unreadSince: Record<string, number>
  /** Host-stamped session-log seq of the newest turn end this renderer has seen. */
  seenTurnEndSeq: Record<string, number>
  /**
   * The host's shared last-read marker: the newest seq any surface (this one,
   * a shared-live phone, another browser) has read. Mirrors the `chat_reads` watch.
   */
  sharedReadSeq: Record<string, number>
  /** `sinceSeq` defaults to the newest turn end seen now. */
  markUnread: (sessionId: string, sinceSeq?: number) => void
  clearUnread: (sessionId: string) => void
  noteTurnEnd: (sessionId: string, seq: number) => void
  setReadMarks: (marks: Record<string, number>) => void
  setReadMark: (sessionId: string, seq: number) => void
}

type DotMaps = Pick<
  AgentChatUnreadState,
  'unread' | 'unreadSince' | 'seenTurnEndSeq' | 'sharedReadSeq'
>

function readElsewhere(state: DotMaps, sessionId: string, since: number): boolean {
  const turnEnd = state.seenTurnEndSeq[sessionId]
  const read = state.sharedReadSeq[sessionId]
  return turnEnd !== undefined && turnEnd > since && read !== undefined && read >= turnEnd
}

function withoutReadDots(state: DotMaps): Pick<DotMaps, 'unread' | 'unreadSince'> {
  let { unread, unreadSince } = state
  for (const sessionId of Object.keys(state.unread)) {
    if (!readElsewhere(state, sessionId, state.unreadSince[sessionId] ?? 0)) continue
    if (unread === state.unread) {
      unread = { ...state.unread }
      unreadSince = { ...state.unreadSince }
    }
    delete unread[sessionId]
    delete unreadSince[sessionId]
  }
  return { unread, unreadSince }
}

/**
 * The single owner of the per-session "Done" ("New activity") flag. The desktop
 * `AgentChatTabInline` and the mobile Recents rows both read it, so a chat's
 * tab and card can never disagree. It is set and cleared by the one shell-level
 * `useAgentChatUnreadTracker` mount (`useShellUnreadTracker`), plus
 * `deleteHistorySession`.
 *
 * Lifetime: a flag is set when a turn finishes (or is cancelled) while the chat
 * is no pane's active tab. It clears when the chat becomes a pane's active tab,
 * when the host's shared last-read marker reaches the turn end that raised it
 * (the chat was read on another surface), or when the chat is deleted. It
 * survives the session leaving the live set and project switches. Never
 * persisted, so an app restart resets it.
 */
export const useAgentChatUnreadStore = create<AgentChatUnreadState>((set) => ({
  unread: {},
  unreadSince: {},
  seenTurnEndSeq: {},
  sharedReadSeq: {},
  markUnread: (sessionId, sinceSeq) => {
    if (!sessionId) return
    set((state) => {
      const since = sinceSeq ?? state.seenTurnEndSeq[sessionId] ?? 0
      if (state.unread[sessionId]) {
        if ((state.unreadSince[sessionId] ?? 0) >= since) return state
        return { unreadSince: { ...state.unreadSince, [sessionId]: since } }
      }
      if (readElsewhere(state, sessionId, since)) return state
      return {
        unread: { ...state.unread, [sessionId]: true },
        unreadSince: { ...state.unreadSince, [sessionId]: since }
      }
    })
  },
  clearUnread: (sessionId) => {
    set((state) => {
      if (!state.unread[sessionId]) return state
      const unread = { ...state.unread }
      const unreadSince = { ...state.unreadSince }
      delete unread[sessionId]
      delete unreadSince[sessionId]
      return { unread, unreadSince }
    })
  },
  noteTurnEnd: (sessionId, seq) => {
    set((state) => {
      if ((state.seenTurnEndSeq[sessionId] ?? 0) >= seq) return state
      const seenTurnEndSeq = { ...state.seenTurnEndSeq, [sessionId]: seq }
      return { seenTurnEndSeq, ...withoutReadDots({ ...state, seenTurnEndSeq }) }
    })
  },
  setReadMarks: (marks) => {
    set((state) => {
      const sharedReadSeq = { ...marks }
      return { sharedReadSeq, ...withoutReadDots({ ...state, sharedReadSeq }) }
    })
  },
  setReadMark: (sessionId, seq) => {
    set((state) => {
      if (state.sharedReadSeq[sessionId] === seq) return state
      const sharedReadSeq = { ...state.sharedReadSeq, [sessionId]: seq }
      return { sharedReadSeq, ...withoutReadDots({ ...state, sharedReadSeq }) }
    })
  }
}))
