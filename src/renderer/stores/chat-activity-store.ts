import type { ChatActivityRecord, ChatActivityWatchDelta } from '@shared/types/web-protocol.types'
import { create } from 'zustand'

interface ChatActivityState {
  /** The host's `chat_activity` records, by session id (`chat-activity-sync`). */
  sessions: Record<string, ChatActivityRecord>
  /**
   * The chats this renderer shows (`activeChatSessionIds`). A shown chat never
   * shows its own "New activity" dot here: reading it is what clears the dot.
   */
  viewing: readonly string[]
  replace: (sessions: Record<string, ChatActivityRecord>) => void
  apply: (delta: ChatActivityWatchDelta) => void
  setViewing: (sessionIds: readonly string[]) => void
}

function isIdle(record: ChatActivityRecord): boolean {
  return !record.busy && !record.needsYou && !record.unread && record.turnEnd === null
}

/**
 * The host's per-chat activity: working, needs you, unread turn end. Every
 * chat list (desktop Chats panel, desktop tab chrome, the phone drawer) reads
 * it, so a chat this renderer never opened shows the same status as one it
 * is driving. Never persisted: the watch sends the full state on subscribe.
 */
export const useChatActivityStore = create<ChatActivityState>((set) => ({
  sessions: {},
  viewing: [],
  replace: (sessions) => set({ sessions: { ...sessions } }),
  apply: ({ sessionId, ...record }) =>
    set((state) => {
      const sessions = { ...state.sessions }
      if (isIdle(record)) delete sessions[sessionId]
      else sessions[sessionId] = record
      return { sessions }
    }),
  setViewing: (viewing) => set({ viewing: [...viewing] })
}))
