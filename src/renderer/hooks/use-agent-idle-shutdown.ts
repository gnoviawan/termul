import { useEffect } from 'react'
import {
  AGENT_IDLE_CHECK_MS,
  AGENT_IDLE_SHUTDOWN_MS,
  type AgentBusyInput,
  isAgentBusy,
  selectAgentsPastIdle,
  shouldStopPreparedAgentOnProjectLeave,
  shutdownAfterLastChatTabClose
} from '@/lib/agent-idle-shutdown'
import { logFrontendError } from '@/lib/log-api'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { parseReuseKey } from '@/stores/acp-reuse-keys'
import { isEphemeralAcpSession, normalizeCwd, useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
import type { PaneNode } from '@/types/workspace.types'

/**
 * Stop ACP agent processes that the UI no longer needs.
 *
 * 1. Closing the last chat tab for a process sends `session/close`, then
 *    `killAgent` (the Node/CLI exit). A turn, queued prompt, permission, or
 *    question keeps the process until that work finishes.
 * 2. A connected process with no open chat tab and no work for 30 minutes
 *    stops the same way. This covers project prewarm. A chat tab that is
 *    still open is left running: closing it would disable the composer.
 *
 * History stays on disk. Reopening a stopped chat uses `openHistorySession`.
 * Leaving a project that is still on the agent entrance stops that project's
 * prewarmed process immediately. A project with a real chat keeps its process.
 */
export function useAgentIdleShutdown(): void {
  useEffect(() => {
    const lastBusyAt = new Map<string, number>()
    const reapWhenIdle = new Set<string>()
    const pendingKill = new Set<string>()
    const killing = new Set<string>()
    const entranceAbandonedCwds = new Set<string>()

    const busyInput = (agentId: string): AgentBusyInput => {
      const state = useAcpStore.getState()
      const queuedPromptSessionIds = new Set<string>()
      for (const [sessionId, queue] of Object.entries(state.promptQueues)) {
        if (queue.length > 0) queuedPromptSessionIds.add(sessionId)
      }
      return {
        agentId,
        agentStatus: state.agentStatus[agentId],
        sessions: Object.values(state.sessions),
        pendingPermissionAgentIds: Object.values(state.pendingPermissions).map((p) => p.agentId),
        pendingQuestionAgentIds: Object.values(state.pendingQuestions).map((q) => q.agentId),
        pendingBrowserAuthAgentIds: Object.keys(state.pendingBrowserOpen),
        launchingSessionIds: new Set(Object.keys(state.launchingSessionIds)),
        queuedPromptSessionIds,
        preparing: isPreparingAgent(agentId, state.preparingChatKeys, state.configToLiveAgent)
      }
    }

    const stamp = (now: number): void => {
      const { agentStatus } = useAcpStore.getState()
      for (const [agentId, status] of Object.entries(agentStatus)) {
        if (status !== 'connected' && status !== 'spawning') continue
        if (!lastBusyAt.has(agentId) || isAgentBusy(busyInput(agentId))) {
          lastBusyAt.set(agentId, now)
        }
      }
    }

    const hasOpenChatTab = (agentId: string): boolean =>
      (openChatTabsByAgent(useWorkspaceStore.getState().root).get(agentId) ?? 0) > 0

    const kill = (agentId: string, reason: string): void => {
      if (killing.has(agentId)) return
      if (useAcpStore.getState().agentStatus[agentId] !== 'connected') return
      if (isAgentBusy(busyInput(agentId)) || hasOpenChatTab(agentId)) return
      killing.add(agentId)
      pendingKill.add(agentId)
      reapWhenIdle.delete(agentId)
      void logFrontendError({
        level: 'info',
        source: 'acp.idleShutdown',
        message: reason
      })
      void (async () => {
        try {
          const sessionIds = Object.values(useAcpStore.getState().sessions)
            .filter((session) => session.agentId === agentId && session.status !== 'closed')
            .map((session) => session.id)
          for (const sessionId of sessionIds) {
            if (isAgentBusy(busyInput(agentId)) || hasOpenChatTab(agentId)) return
            try {
              await useAcpStore.getState().closeSession(sessionId)
            } catch (error) {
              void logFrontendError({
                level: 'warn',
                source: 'acp.idleShutdown',
                message: `session/close failed for ${sessionId} before shutdown: ${error instanceof Error ? error.message : String(error)}`
              })
            }
          }
          if (useAcpStore.getState().agentStatus[agentId] !== 'connected') return
          if (isAgentBusy(busyInput(agentId)) || hasOpenChatTab(agentId)) return
          await useAcpStore.getState().killAgent(agentId)
        } catch (error) {
          void logFrontendError({
            level: 'warn',
            source: 'acp.idleShutdown',
            message: `Failed to shut down agent ${agentId}: ${error instanceof Error ? error.message : String(error)}`
          })
        } finally {
          killing.delete(agentId)
          if (useAcpStore.getState().agentStatus[agentId] !== 'connected') {
            pendingKill.delete(agentId)
            lastBusyAt.delete(agentId)
          }
        }
      })()
    }

    const openChatTabsByAgent = (root: PaneNode): Map<string, number> => {
      const sessions = useAcpStore.getState().sessions
      const counts = new Map<string, number>()
      for (const leaf of getAllLeafPanes(root)) {
        for (const tab of leaf.tabs) {
          if (tab.type !== 'agent-chat') continue
          const agentId = sessions[tab.sessionId]?.agentId
          if (!agentId) continue
          counts.set(agentId, (counts.get(agentId) ?? 0) + 1)
        }
      }
      return counts
    }

    const onChatTabClosed = (sessionId: string): void => {
      const session = useAcpStore.getState().sessions[sessionId]
      if (!session) return
      const agentId = session.agentId
      const remaining = openChatTabsByAgent(useWorkspaceStore.getState().root).get(agentId) ?? 0
      const decision = shutdownAfterLastChatTabClose({
        status: useAcpStore.getState().agentStatus[agentId],
        busy: isAgentBusy(busyInput(agentId)),
        remainingOpenChatTabs: remaining
      })
      if (decision === 'kill') {
        kill(agentId, `Shut down agent ${agentId}: last chat tab closed`)
        return
      }
      if (decision === 'reap-when-idle') reapWhenIdle.add(agentId)
    }

    const releaseEntranceCwd = (cwd: string): void => {
      const norm = normalizeCwd(cwd)
      if (!norm) return
      const state = useAcpStore.getState()
      for (const key of new Set([
        ...Object.keys(state.preparedSessions),
        ...Object.keys(state.preparingChatKeys)
      ])) {
        const keyCwd = normalizeCwd(key.split('\0')[1] ?? '')
        if (keyCwd === norm) state.cancelPreparedChat(key)
      }
      const agentIds = new Set<string>()
      for (const [reuseKey, agentId] of Object.entries(useAcpStore.getState().configToLiveAgent)) {
        // parseReuseKey keeps the real cwd segment for detached keys
        // (`configId\0cwd\0agentId`) so a detached process still counts for
        // its project's cwd.
        if (normalizeCwd(parseReuseKey(reuseKey).cwd) === norm) agentIds.add(agentId)
      }
      let sawUserChat = false
      for (const agentId of agentIds) {
        if (useAcpStore.getState().agentStatus[agentId] !== 'connected') continue
        const sessions = Object.values(useAcpStore.getState().sessions).filter(
          (session) => session.agentId === agentId
        )
        const stop = shouldStopPreparedAgentOnProjectLeave({
          openChatTabs: openChatTabsByAgent(useWorkspaceStore.getState().root).get(agentId) ?? 0,
          pendingPermission: Object.values(useAcpStore.getState().pendingPermissions).some(
            (permission) => permission.agentId === agentId
          ),
          pendingQuestion: Object.values(useAcpStore.getState().pendingQuestions).some(
            (question) => question.agentId === agentId
          ),
          pendingBrowserAuth: agentId in useAcpStore.getState().pendingBrowserOpen,
          sessions: sessions.map((session) => ({
            status: session.status,
            ephemeral: isEphemeralAcpSession(session.id),
            activeTurn: session.activeTurn,
            openTurnId: session.openTurnId,
            replaying: session.replaying,
            launching: session.id in useAcpStore.getState().launchingSessionIds,
            queuedPrompt: (useAcpStore.getState().promptQueues[session.id]?.length ?? 0) > 0
          }))
        })
        if (!stop) {
          sawUserChat = true
          continue
        }
        kill(
          agentId,
          `Shut down agent ${agentId}: left the project entrance without starting a chat`
        )
      }
      if (sawUserChat) entranceAbandonedCwds.delete(norm)
    }

    const reap = (now: number): void => {
      stamp(now)
      const state = useAcpStore.getState()
      const openTabs = openChatTabsByAgent(useWorkspaceStore.getState().root)
      for (const agentId of [...reapWhenIdle, ...pendingKill]) {
        if ((openTabs.get(agentId) ?? 0) > 0) {
          reapWhenIdle.delete(agentId)
          if (pendingKill.delete(agentId)) lastBusyAt.set(agentId, now)
          continue
        }
        if (isAgentBusy(busyInput(agentId))) continue
        if (state.agentStatus[agentId] === 'connected') {
          kill(agentId, `Shut down agent ${agentId}: chat tab closed and the turn finished`)
        }
      }
      const idle = selectAgentsPastIdle(
        Object.entries(state.agentStatus).map(([id, status]) => ({
          id,
          status,
          busy: isAgentBusy(busyInput(id)),
          openChatTabs: openTabs.get(id) ?? 0,
          lastBusyAt: lastBusyAt.get(id) ?? now
        })),
        now
      )
      for (const agentId of idle) {
        kill(
          agentId,
          `Shut down agent ${agentId}: no chat activity for ${AGENT_IDLE_SHUTDOWN_MS / 60_000} minutes`
        )
      }
    }

    stamp(Date.now())
    const unsubAcp = useAcpStore.subscribe(() => {
      stamp(Date.now())
      if (entranceAbandonedCwds.size === 0) return
      for (const cwd of [...entranceAbandonedCwds]) releaseEntranceCwd(cwd)
    })
    let currentProjectId = useProjectStore.getState().activeProjectId
    const unsubProject = useProjectStore.subscribe((state) => {
      const nextId = state.activeProjectId
      if (nextId === currentProjectId) return
      const leftId = currentProjectId
      currentProjectId = nextId
      const nextCwd = normalizeCwd(getDefaultCwdForProject(nextId))
      if (nextCwd) entranceAbandonedCwds.delete(nextCwd)
      const leftCwd = normalizeCwd(getDefaultCwdForProject(leftId))
      if (!leftCwd || leftCwd === nextCwd) return
      entranceAbandonedCwds.add(leftCwd)
      releaseEntranceCwd(leftCwd)
    })
    let previousSessions = openSessionIds(useWorkspaceStore.getState().root)
    const unsubWorkspace = useWorkspaceStore.subscribe((state) => {
      const nextSessions = openSessionIds(state.root)
      for (const sessionId of previousSessions) {
        if (!nextSessions.has(sessionId)) onChatTabClosed(sessionId)
      }
      previousSessions = nextSessions
    })
    const timer = window.setInterval(() => {
      reap(Date.now())
    }, AGENT_IDLE_CHECK_MS)

    return () => {
      unsubAcp()
      unsubProject()
      unsubWorkspace()
      window.clearInterval(timer)
    }
  }, [])
}

function isPreparingAgent(
  agentId: string,
  preparingChatKeys: Record<string, true>,
  configToLiveAgent: Record<string, string>
): boolean {
  const keys = Object.keys(preparingChatKeys)
  if (keys.length === 0) return false
  for (const [reuseKey, liveId] of Object.entries(configToLiveAgent)) {
    if (liveId !== agentId) continue
    // Prefix match also covers detached reuse keys (`configId\0cwd\0agentId`)
    // — a prepare key can never start with one, which is exactly the point of
    // the detached segment (see `acp-reuse-keys.ts`).
    if (keys.some((key) => key === reuseKey || key.startsWith(`${reuseKey}\0`))) return true
  }
  return false
}

function openSessionIds(root: PaneNode): Set<string> {
  const ids = new Set<string>()
  for (const leaf of getAllLeafPanes(root)) {
    for (const tab of leaf.tabs) {
      if (tab.type === 'agent-chat') ids.add(tab.sessionId)
    }
  }
  return ids
}
