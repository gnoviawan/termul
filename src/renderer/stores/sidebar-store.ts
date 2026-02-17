import { create } from 'zustand'

interface SidebarState {
  isVisible: boolean
  toggleVisibility: () => void
  setVisible: (visible: boolean) => void
}

export const useSidebarStore = create<SidebarState>((set) => ({
  isVisible: true,

  toggleVisibility: (): void => {
    set((state) => ({ isVisible: !state.isVisible }))
  },

  setVisible: (visible: boolean): void => {
    set({ isVisible: visible })
  }
}))

export function useSidebarVisible(): boolean {
  return useSidebarStore((state) => state.isVisible)
}
