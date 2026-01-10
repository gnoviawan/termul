import { create } from 'zustand'

interface RecentCommandsState {
  recentCommandIds: string[]
  addRecentCommand: (commandId: string) => void
  setRecentCommands: (ids: string[]) => void
}

const MAX_RECENT_COMMANDS = 5

export const useRecentCommandsStore = create<RecentCommandsState>((set) => ({
  recentCommandIds: [],

  addRecentCommand: (commandId) =>
    set((state) => {
      const filtered = state.recentCommandIds.filter((id) => id !== commandId)
      return {
        recentCommandIds: [commandId, ...filtered].slice(0, MAX_RECENT_COMMANDS)
      }
    }),

  setRecentCommands: (ids) => set({ recentCommandIds: ids })
}))
