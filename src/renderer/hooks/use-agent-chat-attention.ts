import { useMemo } from 'react'
import { useShallow } from 'zustand/shallow'
import { agentChatIsRunning, agentChatNeedsAttention } from '@/lib/agent-chat-attention'
import { isEphemeralAcpSession, useAcpStore } from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'

export interface ProjectAgentChatSignals {
  attentionCounts: Record<string, number>
  /** First open Agent chat in each Project that needs you. */
  firstNeedsYouSessionId: Record<string, string>
  runningProjectIds: ReadonlySet<string>
}

/** Attention counts, the chat to open, and which Projects still have a running process. */
export function useAgentChatProjectSignals(): ProjectAgentChatSignals {
  const sessions = useAcpStore(useShallow((state) => state.sessions ?? {}))
  const agentStatus = useAcpStore(useShallow((state) => state.agentStatus ?? {}))
  const permissionSessionIds = useAcpStore(
    useShallow((state) =>
      Object.values(state.pendingPermissions ?? {}).map((item) => item.sessionId)
    )
  )
  const questionSessionIds = useAcpStore(
    useShallow((state) => Object.values(state.pendingQuestions ?? {}).map((item) => item.sessionId))
  )
  const elicitationSessionIds = useAcpStore(
    useShallow((state) =>
      Object.values(state.pendingElicitations ?? {}).map((item) => item.sessionId)
    )
  )
  const root = useWorkspaceStore((state) => state.root)
  const retainedByProject = useAgentChatLifetimeStore((state) => state.retainedByProject)

  return useMemo(() => {
    const sessionIds = new Set<string>()
    for (const leaf of getAllLeafPanes(root)) {
      for (const tab of leaf.tabs) {
        if (tab.type === 'agent-chat') sessionIds.add(tab.sessionId)
      }
    }
    for (const ids of Object.values(retainedByProject)) {
      for (const sessionId of ids) sessionIds.add(sessionId)
    }
    const permissions = new Set(permissionSessionIds)
    const questions = new Set(questionSessionIds)
    const elicitations = new Set(elicitationSessionIds)
    const attentionCounts: Record<string, number> = {}
    const firstNeedsYouSessionId: Record<string, string> = {}
    const runningProjectIds = new Set<string>()
    for (const sessionId of sessionIds) {
      const session = sessions[sessionId]
      if (!session) continue
      const ephemeral = isEphemeralAcpSession(sessionId)
      const needsAttention = agentChatNeedsAttention({
        projectId: session.projectId,
        sessionStatus: session.status,
        agentStatus: agentStatus[session.agentId],
        pendingPermission: permissions.has(sessionId),
        pendingQuestion: questions.has(sessionId),
        pendingElicitation: elicitations.has(sessionId),
        ephemeral
      })
      if (needsAttention) {
        attentionCounts[session.projectId] = (attentionCounts[session.projectId] ?? 0) + 1
        if (!firstNeedsYouSessionId[session.projectId]) {
          firstNeedsYouSessionId[session.projectId] = sessionId
        }
      }
      if (
        agentChatIsRunning({
          projectId: session.projectId,
          sessionStatus: session.status,
          agentStatus: agentStatus[session.agentId],
          activeTurn: session.activeTurn,
          ephemeral
        })
      ) {
        runningProjectIds.add(session.projectId)
      }
    }
    return { attentionCounts, firstNeedsYouSessionId, runningProjectIds }
  }, [
    agentStatus,
    elicitationSessionIds,
    permissionSessionIds,
    questionSessionIds,
    retainedByProject,
    root,
    sessions
  ])
}
