import { create } from 'zustand'

interface ReportBugState {
  /** True while the Report a Bug dialog is open. */
  open: boolean
  /** Open the Report a Bug dialog. */
  openReport: () => void
  /** Close the dialog. */
  close: () => void
}

/**
 * Open state for the Report a Bug dialog (spec-bug-report-dialog). The
 * dialog is mounted once in `WorkspaceModals` so every entry point — Rail
 * buttons, the command palette, the mobile ⋯ sheets, and the Diagnostics
 * grid — opens the same dialog through `openReport()`. Field state lives
 * inside the dialog: a closed dialog holds no draft.
 */
export const useReportBugStore = create<ReportBugState>((set) => ({
  open: false,

  openReport: (): void => {
    set({ open: true })
  },

  close: (): void => {
    set({ open: false })
  }
}))

/** Reactive selector for the dialog's open flag. */
export function useReportBugOpen(): boolean {
  return useReportBugStore((state) => state.open)
}
