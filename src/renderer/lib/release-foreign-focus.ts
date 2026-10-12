import { UNASSIGNED_PROJECT_ID } from '@shared/types/web-projects.types'
import { chatForeignToProject } from '@/lib/acp-session-ownership'
import { getTabFocusedSessionId, setTabFocusedSessionId } from '@/lib/web-tab-session'
import { useAcpStore } from '@/stores/acp-store'

/**
 * Whether the focus pointer for `sessionId` must not carry over to `projectId`:
 * the chat belongs to another project, or the host stamped it unassigned (it
 * is listed everywhere but retained by no project, so no project's manifest
 * may inherit it as its focus).
 */
function focusMustNotCarryOver(
  sessionId: string,
  projectId: string,
  acp: ReturnType<typeof useAcpStore.getState>
): boolean {
  if (chatForeignToProject(sessionId, projectId, acp)) return true
  const owner =
    acp.sessions[sessionId]?.projectId ||
    acp.sessionIndex.find((entry) => entry.id === sessionId)?.projectId
  return owner === UNASSIGNED_PROJECT_ID
}

/**
 * Clears the active-session and tab-focus pointers when they still name a chat
 * that must not become `projectId`'s focus. Run before selecting a project so a
 * later manifest write cannot persist the previous project's chat on it.
 */
export function releaseFocusNotOwnedBy(projectId: string): void {
  const acp = useAcpStore.getState()
  if (acp.activeSessionId && focusMustNotCarryOver(acp.activeSessionId, projectId, acp)) {
    useAcpStore.setState({ activeSessionId: null })
  }
  const tabFocused = getTabFocusedSessionId()
  if (tabFocused && focusMustNotCarryOver(tabFocused, projectId, acp)) {
    setTabFocusedSessionId(null)
  }
}
