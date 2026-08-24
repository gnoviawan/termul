import { create } from 'zustand'

type SettingsModalView = 'project' | 'app' | null

interface SettingsModalState {
  /** Which settings modal is open, or `null` when none. */
  view: SettingsModalView
  /** Open the Project Settings modal. */
  openProject: () => void
  /** Open the App Preferences modal. */
  openApp: () => void
  /** Close whichever settings modal is open. */
  close: () => void
}

export const useSettingsModalStore = create<SettingsModalState>((set) => ({
  view: null,

  openProject: (): void => {
    set({ view: 'project' })
  },

  openApp: (): void => {
    set({ view: 'app' })
  },

  close: (): void => {
    set({ view: null })
  }
}))

/**
 * Reactive selector for the current settings-modal view. Components (e.g.
 * `ActivityRail`) use this to derive `aria-pressed` without prop-threading.
 */
export function useSettingsModalView(): SettingsModalView {
  return useSettingsModalStore((state) => state.view)
}
