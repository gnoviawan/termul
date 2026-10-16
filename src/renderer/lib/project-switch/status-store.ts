/**
 * Observable state of the project-switch coordinator. `ProjectSwitchIndicator`
 * renders `pending`; this store also raises the failure toast.
 */

import { toast } from 'sonner'
import { create } from 'zustand'
import type { SwitchStatus } from './types'

interface ProjectSwitchStatusState {
  /** The project a switch is currently loading, or null. */
  pending: { projectId: string } | null
  /** The last switch that failed and was rolled back, until the next switch starts or `clearFailed`. */
  failed: { projectId: string; message: string } | null
  clearFailed: () => void
  /**
   * Coordinator -> store. `idle` clears only `pending` (a rolled-back switch's
   * `failed` must survive the noop re-pick that follows the revert); `pending`
   * starts a new attempt and clears `failed`; `failed` ends the attempt.
   */
  apply: (status: SwitchStatus) => void
}

export const useProjectSwitchStatus = create<ProjectSwitchStatusState>((set) => ({
  pending: null,
  failed: null,
  clearFailed: () => set({ failed: null }),
  apply: (status) => {
    switch (status.kind) {
      case 'idle':
        set({ pending: null })
        return
      case 'pending':
        set({ pending: { projectId: status.projectId }, failed: null })
        return
      case 'failed':
        set({ pending: null, failed: { projectId: status.projectId, message: status.message } })
        toast.error('Could not switch project. Try again.')
        return
    }
  }
}))

/**
 * Resolves once no switch toward `projectId` is loading. Code that mutates the
 * visible pane tree on behalf of a project (terminal restore) awaits this:
 * until the commit lands, the visible tree still belongs to the project being
 * left. Resolves immediately when nothing is pending for the project.
 */
export function whenProjectSwitchSettled(projectId: string): Promise<void> {
  if (useProjectSwitchStatus.getState().pending?.projectId !== projectId) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = useProjectSwitchStatus.subscribe((state) => {
      if (state.pending?.projectId === projectId) return
      unsubscribe()
      resolve()
    })
  })
}
