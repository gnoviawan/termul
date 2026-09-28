import { create } from 'zustand'

interface AgentChatLifetimeState {
  /** Open Agent chat session ids kept when that Project is not on screen. */
  retainedByProject: Record<string, string[]>
  closingSessionIds: Record<string, true>
  retainProjectChats: (projectId: string, sessionIds: readonly string[]) => void
  releaseChat: (sessionId: string) => void
  markClosing: (sessionId: string) => void
  clearClosing: (sessionId: string) => void
}

export const useAgentChatLifetimeStore = create<AgentChatLifetimeState>((set) => ({
  retainedByProject: {},
  closingSessionIds: {},
  retainProjectChats: (projectId, sessionIds) => {
    if (!projectId) return
    set((state) => {
      const merged = [...new Set([...(state.retainedByProject[projectId] ?? []), ...sessionIds])]
      return { retainedByProject: { ...state.retainedByProject, [projectId]: merged } }
    })
  },
  releaseChat: (sessionId) => {
    set((state) => {
      const retainedByProject: Record<string, string[]> = {}
      for (const [projectId, ids] of Object.entries(state.retainedByProject)) {
        const next = ids.filter((id) => id !== sessionId)
        if (next.length > 0) retainedByProject[projectId] = next
      }
      const closingSessionIds = { ...state.closingSessionIds }
      delete closingSessionIds[sessionId]
      return { retainedByProject, closingSessionIds }
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
