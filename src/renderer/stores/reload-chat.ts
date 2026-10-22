/**
 * Reload one Agent chat onto a new process without closing its tab.
 *
 * Termul MCP is sent on the reopen. A new process rereads CLI agent config
 * (MCP, skills, plugins). Other open chats keep the old process.
 * The control stays disabled while a reply, queue, or question is open.
 */

import { selectCurrentTurnSubagents, type TurnBoundary } from '@/components/chat/subagent-strip'
import { isSubagentRunning } from '@/components/chat/tool-call-summary'
import { acpApi, type McpServer, type SessionId } from '@/lib/acp-api'
import { selectMcpServersForAgent } from '@/lib/acp-mcp-persistence'
import { decideResume } from '@/lib/acp-resume-policy'
import { logFrontendError } from '@/lib/log-api'
import {
  type AcpState,
  type ChatMessage,
  switchBlockedReason,
  useAcpStore
} from '@/stores/acp-store'
import { ephemeralSessionIds } from '@/stores/acp-store/ephemeral-ids'
import { liveSiblingCount, reloadInFlight } from '@/stores/acp-store/reload-guard'
import { cancelRunningSubagents } from '@/stores/acp-store/subagent-lifecycle'
import { sessionAgentConfigId } from '@/stores/claude-account-switch'

const CANNOT_REOPEN = 'This agent cannot reload a chat. Open a new chat to use the new settings.'
const BACKGROUND_AGENTS_RUNNING =
  'Background agents are still running. Wait until they finish, or stop the reply.'

function lastUserBoundary(messages: readonly ChatMessage[] | undefined): TurnBoundary | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === 'user') return { seq: message.seq, timestamp: message.timestamp }
  }
  return null
}

/**
 * Agents that a reload would stop. A host `running` state counts in every
 * turn: a native subagent keeps running after the user sends another message.
 * A background launch with no host state is only inferred for the current
 * turn, and only while that turn is active.
 */
export function runningBackgroundAgentCount(state: AcpState, sessionId: SessionId): number {
  const toolCalls = state.toolCalls?.[sessionId]
  if (!toolCalls || toolCalls.length === 0) return 0
  const turnActive = Boolean(state.sessions?.[sessionId]?.activeTurn)
  const boundary = lastUserBoundary(state.messages?.[sessionId])
  const knownRunning = selectCurrentTurnSubagents(toolCalls, null).filter(
    (tc) => tc.subagentLifecycle?.state === 'running'
  ).length
  const inferredRunning = selectCurrentTurnSubagents(toolCalls, boundary).filter(
    (tc) =>
      tc.subagentLifecycle?.state !== 'running' &&
      tc.subagentLifecycle?.background === true &&
      isSubagentRunning(tc, turnActive)
  ).length
  return knownRunning + inferredRunning
}

export function agentCanReopenChat(
  capabilities: AcpState['agents'][string]['capabilities'] | null | undefined
): boolean {
  if (!capabilities) return true
  return decideResume({ connected: true, capabilities }) !== 'local'
}

/** Why Reload this chat is unavailable. `null` means the control is enabled. */
export function reloadChatBlockedReason(state: AcpState, sessionId: SessionId): string | null {
  const session = state.sessions?.[sessionId]
  if (!session) return 'This chat is not open.'
  if (ephemeralSessionIds.has(sessionId)) return 'This chat cannot be reloaded.'
  if (session.status !== 'active' && session.status !== 'error') {
    return 'This chat is not ready to reload.'
  }
  const blocked = switchBlockedReason(
    {
      sessions: state.sessions,
      promptQueues: state.promptQueues ?? {},
      pendingPermissions: state.pendingPermissions ?? {},
      pendingQuestions: state.pendingQuestions ?? {},
      pendingElicitations: state.pendingElicitations ?? {},
      pendingBrowserOpen: state.pendingBrowserOpen ?? {},
      launchingSessionIds: state.launchingSessionIds ?? {}
    },
    sessionId
  )
  if (blocked) {
    return runningBackgroundAgentCount(state, sessionId) > 0
      ? BACKGROUND_AGENTS_RUNNING
      : 'Wait until this reply finishes.'
  }
  if (state.reloadingChatIds?.[sessionId]) return 'This chat is reloading.'
  const capabilities = session.agentId ? state.agents?.[session.agentId]?.capabilities : null
  if (capabilities && !agentCanReopenChat(capabilities)) return CANNOT_REOPEN
  return null
}

/**
 * Reload `sessionId`. Keeps the tab and the transcript. Does not send the
 * last prompt again. Throws when the chat is busy or the agent cannot reopen
 * a session. A failed reopen leaves the existing stopped-chat bar.
 */
export async function reloadAgentChat(sessionId: SessionId): Promise<void> {
  const state = useAcpStore.getState()
  const blocked = reloadChatBlockedReason(state, sessionId)
  if (blocked) throw new Error(blocked)

  const session = state.sessions[sessionId]
  const configId = sessionAgentConfigId(state, sessionId)
  const capabilities = state.agents[session.agentId]?.capabilities
  const mcpServers: McpServer[] = selectMcpServersForAgent(
    state.mcpServers ?? [],
    capabilities
  ).servers
  const siblings = liveSiblingCount(state.sessions, sessionId, session.agentId)

  void logFrontendError({
    level: 'info',
    source: 'acp.reloadChat',
    message: `Reloading chat ${sessionId} on a new agent process (config ${configId ?? 'unknown'}, other chats ${siblings})`
  })

  useAcpStore.setState((s) => ({
    reloadingChatIds: { ...s.reloadingChatIds, [sessionId]: true }
  }))
  reloadInFlight.add(sessionId)
  try {
    useAcpStore.getState().flushLiveSessionSaves()
    if (siblings === 0) {
      await useAcpStore.getState().killAgent(session.agentId)
    } else {
      // Release this session on the shared process so the new process can
      // load it. Other chats stay on the old process.
      await acpApi.closeSession(session.agentId, sessionId).catch((error: unknown) => {
        void logFrontendError({
          level: 'warn',
          source: 'acp.reloadChat',
          message: `Could not close chat ${sessionId} on its old process before reload: ${
            error instanceof Error ? error.message : String(error)
          }`
        })
      })
      useAcpStore.setState((s) => {
        const current = s.sessions[sessionId]
        if (!current) return {}
        return {
          sessions: {
            ...s.sessions,
            [sessionId]: {
              ...current,
              status: 'closed',
              activeTurn: false,
              openTurnId: null,
              lastError: null,
              lastErrorCode: null,
              lastErrorData: undefined
            }
          }
        }
      })
    }

    // The old process is gone. Settle before the reopen reads the transcript
    // back, so the new chat does not show those subagents as still running.
    const endedAt = Date.now()
    useAcpStore.setState((s) => {
      const toolCalls = cancelRunningSubagents(s.toolCalls, [sessionId], endedAt)
      return toolCalls === s.toolCalls ? {} : { toolCalls }
    })
    useAcpStore.getState().flushLiveSessionSaves()

    try {
      await useAcpStore.getState().openHistorySession(sessionId, {
        mcpServers,
        forceNewAgent: true
      })
    } catch (error) {
      void logFrontendError({
        level: 'warn',
        source: 'acp.reloadChat',
        message: `Reload of chat ${sessionId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      })
      return
    }

    const reopened = useAcpStore.getState().sessions[sessionId]
    if (reopened?.status !== 'active') return
    const after = useAcpStore.getState()
    const messages = after.messages[sessionId] ?? []
    const afterMessageId = messages.length > 0 ? (messages[messages.length - 1]?.id ?? null) : null
    const seqs = [...messages, ...(after.toolCalls[sessionId] ?? [])]
      .map((item) => item.seq)
      .filter((seq): seq is number => typeof seq === 'number')
    const afterSeq = seqs.length > 0 ? Math.max(...seqs) : null
    const reloadedAt = Date.now()
    useAcpStore.setState((s) => ({
      agentReloadMarks: {
        ...s.agentReloadMarks,
        [sessionId]: { afterMessageId, afterSeq, reloadedAt }
      }
    }))
    void logFrontendError({
      level: 'info',
      source: 'acp.reloadChat',
      message: `Reloaded chat ${sessionId}`
    })
  } finally {
    reloadInFlight.delete(sessionId)
    useAcpStore.setState((s) => {
      if (!(sessionId in s.reloadingChatIds)) return {}
      const reloadingChatIds = { ...s.reloadingChatIds }
      delete reloadingChatIds[sessionId]
      return { reloadingChatIds }
    })
  }
}
