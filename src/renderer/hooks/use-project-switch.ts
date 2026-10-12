import { useMemo } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { releaseFocusNotOwnedBy } from '@/lib/release-foreign-focus'
import { useAcpStore } from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useProjectStore } from '@/stores/project-store'

/**
 * How a `switchTo` call ended. `selected`: the project is now active on this
 * client. `ignored`: nothing changed because the target is unknown, archived
 * or already active.
 */
export type ProjectSwitchStatus = 'selected' | 'ignored'

export interface ProjectSwitch {
  /** Makes `projectId` this client's active project; see {@link ProjectSwitchStatus}. */
  switchTo: (projectId: string) => ProjectSwitchStatus
}

/**
 * Asks the workspace restore to reopen the project's most recent persisted
 * chat when the project has none on screen to come back to (switch-back
 * restore). A chat the user left open there keeps winning, so this only fills
 * the gap. Returns the requested session id, or `null` when nothing was asked.
 */
function requestMostRecentChat(projectId: string): string | null {
  const lifetime = useAgentChatLifetimeStore.getState()
  if (
    (lifetime.retainedByProject[projectId]?.length ?? 0) > 0 ||
    lifetime.activeSessionByProject[projectId] ||
    lifetime.focusSessionByProject[projectId]
  ) {
    return null
  }
  let latest: { id: string; lastActivityAt: number } | null = null
  for (const entry of useAcpStore.getState().sessionIndex) {
    if (entry.projectId !== projectId || entry.discovered) continue
    if (!latest || entry.lastActivityAt > latest.lastActivityAt) latest = entry
  }
  if (!latest) return null
  lifetime.retainProjectChats(projectId, [latest.id])
  lifetime.requestFocus(projectId, latest.id)
  return latest.id
}

/**
 * The one project-switch routine behind the project sheet and the mobile
 * command palette. Switching is client-only: it changes this client's active
 * project (the persisted `web-active-project` choice) and nothing on the host —
 * no request is sent, so sessions and PTYs, here and on every other device,
 * are untouched. Chats are bound to their project by the host when they are
 * created (`create_session.projectId`).
 *
 * `source` names the caller in the log line.
 */
export function useProjectSwitch(source: string): ProjectSwitch {
  return useMemo(
    () => ({
      switchTo: (projectId: string): ProjectSwitchStatus => {
        const { projects, activeProjectId, selectProject } = useProjectStore.getState()
        const project = projects.find((candidate) => candidate.id === projectId)
        if (!project || project.isArchived || projectId === activeProjectId) return 'ignored'
        // The focus pointers still name the PREVIOUS project's chat: clear
        // them so a later manifest write cannot inherit that session on the
        // target project.
        releaseFocusNotOwnedBy(projectId)
        const restored = requestMostRecentChat(projectId)
        selectProject(projectId)
        void logFrontendError({
          level: 'info',
          source,
          message: `Project switched ${activeProjectId} -> ${projectId} (client-only${restored ? ', most recent chat restore requested' : ''})`
        })
        return 'selected'
      }
    }),
    [source]
  )
}
