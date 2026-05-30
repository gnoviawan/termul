import { create } from 'zustand'

interface SSHPanelState {
  isVisible: boolean
  toggleVisibility: () => void
  setVisible: (visible: boolean) => void
}

export const useSSHPanelStore = create<SSHPanelState>((set) => ({
  isVisible: true,

  toggleVisibility: (): void => {
    set((state) => ({ isVisible: !state.isVisible }))
  },

  setVisible: (visible: boolean): void => {
    set({ isVisible: visible })
  }
}))

export function useSSHPanelVisible(): boolean {
  return useSSHPanelStore((state) => state.isVisible)
}
