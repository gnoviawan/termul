import { toast } from 'sonner'
import { create } from 'zustand'
import { getActiveWorkingCopy, reportUnresolvedWorkingCopy } from '@/lib/active-working-copy'
import { logFrontendError } from '@/lib/log-api'
import { recordSheetOpener } from '@/lib/sheet-focus-return'
import { useProjectStore } from '@/stores/project-store'

/** Where the Git sheet's working directory came from (logged at open). */
export type GitSheetCwdSource = 'explicit' | 'working-copy'

interface GitSheetState {
  /** Whether the mobile Git Changes sheet is open. */
  open: boolean
  /** Directory the sheet was opened on. Snapshotted at open; kept while closing so the exit animation keeps its content. */
  cwd: string
  /** Active project id recorded at open ('' when unknown); a different active project closes the sheet. */
  projectId: string
  /**
   * Open the sheet on `cwd`, or on the active working copy (active tab, else
   * the switcher pick, else the project folder) when omitted. An unresolved
   * working copy never opens the sheet and triggers a worktree reconcile. `opener` is the control the sheet returns focus to on close; it is
   * recorded only when the sheet actually opens, and an omitted one leaves the
   * opener a caller already recorded (the header ⋯ row) in place.
   */
  openGitSheet: (cwd?: string, opener?: HTMLElement | null) => void
  closeGitSheet: () => void
}

/**
 * Open state for the mobile Git Changes sheet, lifted out of `WorkspaceLayout`
 * so the chat status pill's changed-files list can open it. Renderer-only: no
 * transport or backend change.
 */
export const useGitSheetStore = create<GitSheetState>((set) => ({
  open: false,
  cwd: '',
  projectId: '',

  openGitSheet: (explicitCwd, opener): void => {
    const projectId = useProjectStore.getState().activeProjectId
    let cwd = typeof explicitCwd === 'string' && explicitCwd.trim().length > 0 ? explicitCwd : null
    let source: GitSheetCwdSource = 'explicit'
    if (!cwd) {
      const wc = projectId ? getActiveWorkingCopy(projectId) : null
      if (wc?.state === 'unresolved') {
        reportUnresolvedWorkingCopy(projectId, wc)
        toast.error('This worktree is no longer available', {
          description: 'Termul is refreshing the worktree list.'
        })
        void logFrontendError({
          level: 'warn',
          source: 'git-sheet-store',
          message: `Git sheet not opened: unresolved working copy (project ${projectId})`
        })
        return
      }
      cwd = wc?.path ?? null
      source = 'working-copy'
    }
    if (!cwd) {
      void logFrontendError({
        level: 'warn',
        source: 'git-sheet-store',
        message: `Git sheet not opened: no cwd resolved (project ${projectId || 'none'})`
      })
      return
    }
    void logFrontendError({
      level: 'info',
      source: 'git-sheet-store',
      message: `Git sheet opened from ${source} cwd`
    })
    recordSheetOpener('git-sheet', opener)
    set({ open: true, cwd, projectId })
  },

  closeGitSheet: (): void => {
    set({ open: false })
  }
}))
