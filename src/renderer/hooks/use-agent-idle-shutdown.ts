import { useEffect } from 'react'
import {
  AGENT_IDLE_CHECK_MS,
  AGENT_IDLE_SHUTDOWN_MS,
  type AgentBusyInput,
  agentChatCloseAction,
  closingTurnStillRunning,
  disappearedChatIsStillOpen,
  isAgentBusy,
  openChatCountForAgent,
  selectAgentsPastIdle,
  shouldStopPreparedAgentOnProjectLeave,
  shutdownAfterLastChatTabClose
} from '@/lib/agent-idle-shutdown'
import { logFrontendError } from '@/lib/log-api'
import { markChatClosedOnRoute } from '@/lib/web-tab-session'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { parseReuseKey } from '@/stores/acp-reuse-keys'
import { isEphemeralAcpSession, normalizeCwd, useAcpStore } from '@/stores/acp-store'
import {
  retainedAgentChatSessionIds,
  useAgentChatLifetimeStore
} from '@/stores/agent-chat-lifetime-store'
import { useProjectStore } from '@/stores/project-store'
import { agentChatTabId, getAllLeafPanes, useWorkspaceStore } from '@/stores/workspace-store'
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

    const retainedSessionIds = (): Set<string> =>
      retainedAgentChatSessionIds(useAgentChatLifetimeStore.getState().retainedByProject)

    const trackedChats = (root: PaneNode): { sessionId: string; agentId: string | undefined }[] => {
      const sessions = useAcpStore.getState().sessions
      const chats: { sessionId: string; agentId: string | undefined }[] = []
      const seen = new Set<string>()
      const push = (sessionId: string): void => {
        if (seen.has(sessionId)) return
        seen.add(sessionId)
        chats.push({ sessionId, agentId: sessions[sessionId]?.agentId })
      }
      for (const leaf of getAllLeafPanes(root)) {
        for (const tab of leaf.tabs) {
          if (tab.type === 'agent-chat') push(tab.sessionId)
        }
      }
      for (const sessionId of retainedSessionIds()) push(sessionId)
      return chats
    }

    const openChatTabsByAgent = (root: PaneNode): Map<string, number> => {
      const chats = trackedChats(root)
      const counts = new Map<string, number>()
      const agentIds = new Set(chats.map((chat) => chat.agentId).filter((id): id is string => !!id))
      for (const agentId of agentIds) {
        counts.set(agentId, openChatCountForAgent({ agentId, chats }))
      }
      return counts
    }

    const finishClosingChats = (): void => {
      const closing = useAgentChatLifetimeStore.getState().closingSessionIds
      for (const sessionId of Object.keys(closing)) {
        const session = useAcpStore.getState().sessions[sessionId]
        if (!session) {
          useAgentChatLifetimeStore.getState().clearClosing(sessionId)
          continue
        }
        if (closingTurnStillRunning(busyInput(session.agentId))) continue
        useAgentChatLifetimeStore.getState().clearClosing(sessionId)
        useAgentChatLifetimeStore.getState().releaseChat(sessionId)
        markChatClosedOnRoute(sessionId)
        const visible = openSessionIds(useWorkspaceStore.getState().root).has(sessionId)
        if (visible) {
          useWorkspaceStore.getState().removeTab(agentChatTabId(sessionId))
          continue
        }
        kill(session.agentId, `Shut down agent ${session.agentId}: Closing finished`)
      }
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
      finishClosingChats()
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
      const retained = retainedSessionIds()
      for (const sessionId of previousSessions) {
        if (nextSessions.has(sessionId)) continue
        if (disappearedChatIsStillOpen(sessionId, retained)) continue
        onChatTabClosed(sessionId)
      }
      previousSessions = nextSessions
    })
    const timer = window.setInterval(() => {
      finishClosingChats()
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

/** Close an Agent chat. A running turn stays on screen until it finishes. */
export function requestCloseAgentChat(sessionId: string, closeTab: () => void): void {
  const state = typeof useAcpStore.getState === 'function' ? useAcpStore.getState() : null
  const session = state?.sessions?.[sessionId]
  const queuedPromptSessionIds = new Set<string>()
  for (const [id, queue] of Object.entries(state?.promptQueues ?? {})) {
    if (queue.length > 0) queuedPromptSessionIds.add(id)
  }
  const busy =
    session && state
      ? isAgentBusy({
          agentId: session.agentId,
          agentStatus: state.agentStatus?.[session.agentId],
          sessions: Object.values(state.sessions ?? {}),
          pendingPermissionAgentIds: Object.values(state.pendingPermissions ?? {}).map(
            (p) => p.agentId
          ),
          pendingQuestionAgentIds: Object.values(state.pendingQuestions ?? {}).map(
            (q) => q.agentId
          ),
          pendingBrowserAuthAgentIds: Object.keys(state.pendingBrowserOpen ?? {}),
          launchingSessionIds: new Set(Object.keys(state.launchingSessionIds ?? {})),
          queuedPromptSessionIds,
          preparing: isPreparingAgent(
            session.agentId,
            state.preparingChatKeys,
            state.configToLiveAgent
          )
        })
      : false
  if (agentChatCloseAction(busy) === 'closing') {
    useAgentChatLifetimeStore.getState().markClosing(sessionId)
    void logFrontendError({
      level: 'info',
      source: 'acp.agentChatClose',
      message: `Agent chat ${sessionId} is Closing until the turn finishes`
    })
    return
  }
  useAgentChatLifetimeStore.getState().releaseChat(sessionId)
  // Route-scoped closed signal: the route (`#/c/<sessionId>`) survives this
  // close, so ChatRoute must not resurrect the chat on a later pane-tree
  // change. Synchronous and independent of acp-store timing (the close may
  // race the mount-time openHistorySession still being in flight).
  markChatClosedOnRoute(sessionId)
  void logFrontendError({
    level: 'info',
    source: 'acp.agentChatClose',
    message: `Closed agent chat ${sessionId}`
  })
  closeTab()
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
