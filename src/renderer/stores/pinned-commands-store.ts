import { create } from 'zustand'

interface PinnedCommandsState {
  pinnedCommandIds: string[]
  togglePinned: (commandId: string) => void
  setPinned: (ids: string[]) => void
}

export const usePinnedCommandsStore = create<PinnedCommandsState>((set) => ({
  pinnedCommandIds: [],

  togglePinned: (commandId) =>
    set((state) => ({
      pinnedCommandIds: state.pinnedCommandIds.includes(commandId)
        ? state.pinnedCommandIds.filter((id) => id !== commandId)
        : [...state.pinnedCommandIds, commandId]
    })),

  setPinned: (ids) => set({ pinnedCommandIds: ids })
}))
