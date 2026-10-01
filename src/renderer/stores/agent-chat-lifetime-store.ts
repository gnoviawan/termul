import { create } from 'zustand'

interface AgentChatLifetimeState {
  /** Open Agent chat session ids kept when that Project is not on screen. */
  retainedByProject: Record<string, string[]>
  /** Agent chat that was the active tab when the user left the Project. */
  activeSessionByProject: Record<string, string>
  /** One-shot focus, for example a click on “needs you”. Wins over the remembered tab. */
  focusSessionByProject: Record<string, string>
  closingSessionIds: Record<string, true>
  retainProjectChats: (projectId: string, sessionIds: readonly string[]) => void
  rememberActiveChat: (projectId: string, sessionId: string | null) => void
  requestFocus: (projectId: string, sessionId: string) => void
  /** Returns the session to show, then clears the one-shot focus. */
  takeFocus: (projectId: string) => string | null
  releaseChat: (sessionId: string) => void
  markClosing: (sessionId: string) => void
  clearClosing: (sessionId: string) => void
}

export const useAgentChatLifetimeStore = create<AgentChatLifetimeState>((set, get) => ({
  retainedByProject: {},
  activeSessionByProject: {},
  focusSessionByProject: {},
  closingSessionIds: {},
  retainProjectChats: (projectId, sessionIds) => {
    if (!projectId) return
    set((state) => {
      const merged = [...new Set([...(state.retainedByProject[projectId] ?? []), ...sessionIds])]
      return { retainedByProject: { ...state.retainedByProject, [projectId]: merged } }
    })
  },
  rememberActiveChat: (projectId, sessionId) => {
    if (!projectId) return
    set((state) => {
      const activeSessionByProject = { ...state.activeSessionByProject }
      if (sessionId) activeSessionByProject[projectId] = sessionId
      else delete activeSessionByProject[projectId]
      return { activeSessionByProject }
    })
  },
  requestFocus: (projectId, sessionId) => {
    if (!projectId || !sessionId) return
    set((state) => ({
      focusSessionByProject: { ...state.focusSessionByProject, [projectId]: sessionId }
    }))
  },
  takeFocus: (projectId): string | null => {
    const state = get()
    const requested = state.focusSessionByProject[projectId]
    const remembered = state.activeSessionByProject[projectId]
    if (requested) {
      const focusSessionByProject = { ...state.focusSessionByProject }
      delete focusSessionByProject[projectId]
      set({ focusSessionByProject })
    }
    return requested ?? remembered ?? null
  },
  releaseChat: (sessionId) => {
    set((state) => {
      const retainedByProject: Record<string, string[]> = {}
      for (const [projectId, ids] of Object.entries(state.retainedByProject)) {
        const next = ids.filter((id) => id !== sessionId)
        if (next.length > 0) retainedByProject[projectId] = next
      }
      const drop = (map: Record<string, string>): Record<string, string> => {
        const next: Record<string, string> = {}
        for (const [projectId, id] of Object.entries(map)) {
          if (id !== sessionId) next[projectId] = id
        }
        return next
      }
      const closingSessionIds = { ...state.closingSessionIds }
      delete closingSessionIds[sessionId]
      return {
        retainedByProject,
        closingSessionIds,
        activeSessionByProject: drop(state.activeSessionByProject),
        focusSessionByProject: drop(state.focusSessionByProject)
      }
    })
  },
  markClosing: (sessionId) => {
    set((state) => ({
      closingSessionIds: { ...state.closingSessionIds, [sessionId]: true }
    }))
  },
  clearClosing: (sessionId) => {
    set((state) => {
      if (!state.closingSessionIds[sessionId]) return state
      const closingSessionIds = { ...state.closingSessionIds }
      delete closingSessionIds[sessionId]
      return { closingSessionIds }
    })
  }
}))

export function retainedAgentChatSessionIds(
  retainedByProject: Record<string, readonly string[]>
): Set<string> {
  const ids = new Set<string>()
  for (const list of Object.values(retainedByProject)) {
    for (const id of list) ids.add(id)
  }
  return ids
}
