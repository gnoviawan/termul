import { create } from 'zustand'

interface AgentChatUnreadState {
  /** Sessions whose turn finished while they were not the active chat ("New activity"). */
  unread: Record<string, true>
  markUnread: (sessionId: string) => void
  clearUnread: (sessionId: string) => void
}

/**
 * Renderer-only, per-session "New activity" flags for the mobile drawer's Open
 * rows. Never persisted and never reset on a project switch: a chat that
 * finished off-screen keeps its dot until it is viewed. The desktop
 * `AgentChatTabInline` keeps its own component-local unread and does not read
 * this store. Driven by `useAgentChatUnreadTracker`.
 */
export const useAgentChatUnreadStore = create<AgentChatUnreadState>((set) => ({
  unread: {},
  markUnread: (sessionId) => {
    if (!sessionId) return
    set((state) =>
      state.unread[sessionId] ? state : { unread: { ...state.unread, [sessionId]: true } }
    )
  },
  clearUnread: (sessionId) => {
    set((state) => {
      if (!state.unread[sessionId]) return state
      const unread = { ...state.unread }
      delete unread[sessionId]
      return { unread }
    })
  }
}))
