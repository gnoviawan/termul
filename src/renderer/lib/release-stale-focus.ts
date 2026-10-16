import { UNASSIGNED_PROJECT_ID } from '@shared/types/web-projects.types'
import { getTabFocusedSessionId, setTabFocusedSessionId } from '@/lib/web-tab-session'
import { sessionProjectId, useAcpStore } from '@/stores/acp-store'

type FocusState = Pick<ReturnType<typeof useAcpStore.getState>, 'sessions' | 'sessionIndex'>

/**
 * Whether the focus pointer for `sessionId` must not carry over to `projectId`:
 * the session record names another project, or the host stamped it unassigned
 * (listed everywhere but retained by no project, so no project's manifest may
 * inherit it as its focus). A read of the session record, not a filter on any
 * tree's content.
 */
function focusMustNotCarryOver(sessionId: string, projectId: string, acp: FocusState): boolean {
  const owner = sessionProjectId(acp, sessionId)
  if (owner !== undefined) return owner !== projectId
  const raw =
    acp.sessions[sessionId]?.projectId ||
    acp.sessionIndex.find((entry) => entry.id === sessionId)?.projectId
  return raw === UNASSIGNED_PROJECT_ID
}

/**
 * Clears the active-session and tab-focus pointers when they still name a chat
 * that must not become `projectId`'s focus. Run before selecting a project so a
 * later manifest write cannot persist the previous project's chat on it.
 */
export function releaseFocusNotOfProject(projectId: string): void {
  const acp = useAcpStore.getState()
  if (acp.activeSessionId && focusMustNotCarryOver(acp.activeSessionId, projectId, acp)) {
    useAcpStore.setState({ activeSessionId: null })
  }
  const tabFocused = getTabFocusedSessionId()
  if (tabFocused && focusMustNotCarryOver(tabFocused, projectId, acp)) {
    setTabFocusedSessionId(null)
  }
}
