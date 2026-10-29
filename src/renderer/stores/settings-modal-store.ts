import { create } from 'zustand'

type SettingsModalView = 'project' | 'app' | null

interface SettingsModalState {
  /** Which settings modal is open, or `null` when none. */
  view: SettingsModalView
  /** Active App Preferences page id, or `null` for the first page. */
  appPage: string | null
  /** Active Project Settings page id, or `null` for the first page. */
  projectPage: string | null
  /**
   * Project the Project Settings modal edits, or `null` for the active
   * project. Set on open so a menu can edit a project without selecting it.
   */
  projectId: string | null
  /**
   * Open the Project Settings modal, optionally on one page and for one
   * project. Without a `projectId` it edits the active project.
   */
  openProject: (page?: string, projectId?: string) => void
  /** Open the App Preferences modal, optionally on one page. */
  openApp: (page?: string) => void
  /** Change the active App Preferences page. */
  setAppPage: (page: string) => void
  /** Change the active Project Settings page. */
  setProjectPage: (page: string) => void
  /** Close whichever settings modal is open. */
  close: () => void
}

export const useSettingsModalStore = create<SettingsModalState>((set) => ({
  view: null,
  appPage: null,
  projectPage: null,
  projectId: null,

  openProject: (page?: string, projectId?: string): void => {
    set({ view: 'project', projectPage: page ?? null, projectId: projectId || null })
  },

  openApp: (page?: string): void => {
    set({ view: 'app', appPage: page ?? null, projectId: null })
  },

  setAppPage: (page: string): void => {
    set({ appPage: page })
  },

  setProjectPage: (page: string): void => {
    set({ projectPage: page })
  },

  close: (): void => {
    set({ view: null, projectId: null })
  }
}))

/**
 * Reactive selector for the current settings-modal view. Components (e.g.
 * the Rail footer) use this to derive `aria-pressed` without prop-threading.
 */
export function useSettingsModalView(): SettingsModalView {
  return useSettingsModalStore((state) => state.view)
}
