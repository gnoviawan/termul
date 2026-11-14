import { columnTabId } from '@/components/shell/ColumnTabs'
import { logFrontendError } from '@/lib/log-api'
import { type ShellLastColumnTab, useShellLayoutStore } from '@/stores/shell-layout-store'

/** Frames to wait for the revealed Side panel to mount its tab bar. */
const FOCUS_FRAMES = 10

/** Focuses the Side panel's tab once it mounts. */
export function focusPanelTab(tab: ShellLastColumnTab): void {
  let frames = 0
  const attempt = (): void => {
    const el = document.getElementById(columnTabId(tab))
    if (el) el.focus()
    else if (++frames < FOCUS_FRAMES) requestAnimationFrame(attempt)
  }
  requestAnimationFrame(attempt)
}

/**
 * Shows the project's Changes tab in the Side panel (the desktop Git view)
 * and moves focus to the tab. Used by "Review changes" in the chat.
 */
export function openChangesTab(projectId: string): void {
  const layout = useShellLayoutStore.getState()
  layout.setLastColumnTab(projectId, 'changes')
  layout.setSidePanelVisible(true)
  void logFrontendError({
    level: 'info',
    message: `openChangesTab: show the Changes tab for project ${projectId}`,
    source: 'column-tab-focus'
  })
  focusPanelTab('changes')
}
