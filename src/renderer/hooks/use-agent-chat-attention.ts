import { useMemo } from 'react'
import { useShallow } from 'zustand/shallow'
import { agentChatNeedsAttention } from '@/lib/agent-chat-attention'
import { isEphemeralAcpSession, useAcpStore } from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'

/** Attention counts keyed by Project id. A finished turn does not add to the count. */
export function useAgentChatAttentionCounts(): Record<string, number> {
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
    const counts: Record<string, number> = {}
    for (const sessionId of sessionIds) {
      const session = sessions[sessionId]
      if (!session) continue
      const needsAttention = agentChatNeedsAttention({
        projectId: session.projectId,
        sessionStatus: session.status,
        agentStatus: agentStatus[session.agentId],
        pendingPermission: permissions.has(sessionId),
        pendingQuestion: questions.has(sessionId),
        ephemeral: isEphemeralAcpSession(sessionId)
      })
      if (!needsAttention) continue
      counts[session.projectId] = (counts[session.projectId] ?? 0) + 1
    }
    return counts
  }, [agentStatus, permissionSessionIds, questionSessionIds, retainedByProject, root, sessions])
}
