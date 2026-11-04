import { useMemo } from 'react'
import { useShallow } from 'zustand/shallow'
import { agentChatIsRunning, chatNeedsYou, chatProjectId } from '@/lib/agent-chat-attention'
import { isEphemeralAcpSession, useAcpStore } from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useChatActivityStore } from '@/stores/chat-activity-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'

export interface ProjectAgentChatSignals {
  attentionCounts: Record<string, number>
  /** First Agent chat in each Project that needs you: open chats in tab order, then the rest. */
  firstNeedsYouSessionId: Record<string, string>
  /** Session id to Project id of every Agent chat that needs you. */
  needsYouChats: ReadonlyMap<string, string>
  /** Projects where the host has an Agent chat working. */
  workingProjectIds: ReadonlySet<string>
  /** Projects with an open Agent chat whose process is connected and idle. */
  runningProjectIds: ReadonlySet<string>
}

/**
 * Per-Project Needs you, Working and running signals of the Agent chats. Needs
 * you and Working come from the host's `chat_activity` records, so a chat
 * this surface never opened counts under its Project. The open chats (tabs
 * and retained chats) add what only this renderer's Session knows: a
 * disconnected Agent, a closed chat that cannot resume, an idle process.
 */
export function useAgentChatProjectSignals(): ProjectAgentChatSignals {
  const sessions = useAcpStore(useShallow((state) => state.sessions ?? {}))
  const agentStatus = useAcpStore(useShallow((state) => state.agentStatus ?? {}))
  const activity = useChatActivityStore((state) => state.sessions)
  const root = useWorkspaceStore((state) => state.root)
  const retainedByProject = useAgentChatLifetimeStore((state) => state.retainedByProject)

  return useMemo(() => {
    const openChatIds = new Set<string>()
    for (const leaf of getAllLeafPanes(root)) {
      for (const tab of leaf.tabs) {
        if (tab.type === 'agent-chat') openChatIds.add(tab.sessionId)
      }
    }
    for (const ids of Object.values(retainedByProject)) {
      for (const sessionId of ids) openChatIds.add(sessionId)
    }
    const needsYouChats = new Map<string, string>()
    const workingProjectIds = new Set<string>()
    const runningProjectIds = new Set<string>()
    for (const sessionId of new Set([...openChatIds, ...Object.keys(activity)])) {
      if (isEphemeralAcpSession(sessionId)) continue
      const record = activity[sessionId]
      const session = sessions[sessionId]
      const projectId = chatProjectId(record, session)
      if (!projectId) continue
      const open = openChatIds.has(sessionId)
      const status = session ? agentStatus[session.agentId] : undefined
      if (chatNeedsYou(record, open ? session : undefined, status)) {
        needsYouChats.set(sessionId, projectId)
      }
      if (record?.busy) workingProjectIds.add(projectId)
      if (
        open &&
        session &&
        agentChatIsRunning({
          projectId: session.projectId,
          sessionStatus: session.status,
          agentStatus: status,
          activeTurn: session.activeTurn,
          ephemeral: false
        })
      ) {
        runningProjectIds.add(session.projectId)
      }
    }
    const attentionCounts: Record<string, number> = {}
    const firstNeedsYouSessionId: Record<string, string> = {}
    for (const [sessionId, projectId] of needsYouChats) {
      attentionCounts[projectId] = (attentionCounts[projectId] ?? 0) + 1
      firstNeedsYouSessionId[projectId] ??= sessionId
    }
    return {
      attentionCounts,
      firstNeedsYouSessionId,
      needsYouChats,
      workingProjectIds,
      runningProjectIds
    }
  }, [activity, agentStatus, retainedByProject, root, sessions])
}
