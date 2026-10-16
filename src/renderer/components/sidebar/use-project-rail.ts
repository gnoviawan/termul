import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAgentChatProjectSignals } from '@/hooks/use-agent-chat-attention'
import { useProjectsWithActiveAgentChat } from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useProjectsWithActivity, useProjectsWithErrors } from '@/stores/terminal-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { type ProjectRowStatus, resolveProjectLiveState } from './indicators'

interface UseProjectRailOptions {
  activeProjectId: string | null | undefined
  onSelectProject: (projectId: string) => void
}

export interface ProjectRail {
  /** Live work, agent chats that need you, and a crashed terminal. */
  status: (projectId: string) => ProjectRowStatus
  /** Switches to the project and goes to the workspace. The main click of a row or icon. */
  openProject: (projectId: string) => void
  /** Opens the project's first chat that needs you; the project alone when there is none. */
  openNeedsYou: (projectId: string) => void
}

/**
 * Status and actions of the Rail's projects, shared by the expanded rows, the
 * collapsed icons and the Project switcher so they agree. One subscription to
 * which projects have activity (not to terminal output) and to the agent chat
 * signals.
 */
export function useProjectRail({
  activeProjectId,
  onSelectProject
}: UseProjectRailOptions): ProjectRail {
  const navigate = useNavigate()
  const [projectActivityIds, projectErrorIds] = [useProjectsWithActivity(), useProjectsWithErrors()]
  const agentChatActivityIds = useProjectsWithActiveAgentChat()
  const { attentionCounts, firstNeedsYouSessionId, runningProjectIds } =
    useAgentChatProjectSignals()

  const status = useCallback(
    (projectId: string): ProjectRowStatus => ({
      live: resolveProjectLiveState(
        projectActivityIds.includes(projectId) || agentChatActivityIds.includes(projectId),
        runningProjectIds.has(projectId)
      ),
      attentionCount: attentionCounts[projectId] ?? 0,
      crashed: projectErrorIds.has(projectId)
    }),
    [projectActivityIds, agentChatActivityIds, runningProjectIds, attentionCounts, projectErrorIds]
  )

  const openProject = useCallback(
    (projectId: string) => {
      onSelectProject(projectId)
      navigate('/')
    },
    [navigate, onSelectProject]
  )

  const openNeedsYou = useCallback(
    (projectId: string) => {
      const sessionId = firstNeedsYouSessionId[projectId]
      if (sessionId && projectId === activeProjectId) {
        useWorkspaceStore.getState().addAgentChatTab(sessionId)
        return
      }
      if (sessionId) {
        useAgentChatLifetimeStore.getState().requestFocus(projectId, sessionId)
      }
      openProject(projectId)
    },
    [activeProjectId, firstNeedsYouSessionId, openProject]
  )

  return { status, openProject, openNeedsYou }
}
