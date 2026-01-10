import { create } from 'zustand'

export interface CommandHistoryEntry {
  id: string
  command: string
  terminalName: string
  terminalId: string
  projectId: string
  timestamp: number
}

interface CommandHistoryState {
  entries: CommandHistoryEntry[]
  addCommand: (entry: Omit<CommandHistoryEntry, 'id'>) => void
  clearHistory: (projectId: string) => void
  setHistory: (entries: CommandHistoryEntry[]) => void
}

const MAX_HISTORY_ENTRIES = 500

export const useCommandHistoryStore = create<CommandHistoryState>((set) => ({
  entries: [],

  addCommand: (entry) =>
    set((state) => {
      const newEntry: CommandHistoryEntry = {
        ...entry,
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      }
      // Add to front, limit total entries
      const filtered = state.entries.filter((e) => e.projectId === entry.projectId)
      const otherProjects = state.entries.filter((e) => e.projectId !== entry.projectId)
      const projectEntries = [newEntry, ...filtered].slice(0, MAX_HISTORY_ENTRIES)
      return {
        entries: [...projectEntries, ...otherProjects]
      }
    }),

  clearHistory: (projectId) =>
    set((state) => ({
      entries: state.entries.filter((e) => e.projectId !== projectId)
    })),

  setHistory: (entries) => set({ entries })
}))
