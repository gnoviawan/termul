/**
 * Account switch for Claude Agent chats (ADR-0004): after a Project's Claude
 * Account changes, each open Claude chat of that Project restarts on a fresh
 * agent process (which the host starts with the new Account) and resumes the
 * same session. Idle chats restart at once; busy chats after their turn ends.
 * A chat stopped by a usage limit can cancel its held turn and send the last
 * prompt again on the new Account.
 */

import { claudeAccountsApi } from '@/lib/claude-accounts-api'
import { logFrontendError } from '@/lib/log-api'
import { type AcpState, switchBlockedReason, useAcpStore } from '@/stores/acp-store'

/** Config id of the host-managed Claude ACP agent. */
export const CLAUDE_AGENT_CONFIG_ID = 'acp-registry:claude-acp'

/** The agent config of a chat: the live reuse-key map first, then the session index. */
export function sessionAgentConfigId(state: AcpState, sessionId: string): string | null {
  const session = state.sessions?.[sessionId]
  if (session?.agentId) {
    for (const [key, id] of Object.entries(state.configToLiveAgent ?? {})) {
      if (id === session.agentId) return key.split('\0')[0] ?? null
    }
  }
  return state.sessionIndex?.find((entry) => entry.id === sessionId)?.agentConfigId ?? null
}

export function isClaudeSession(state: AcpState, sessionId: string): boolean {
  return sessionAgentConfigId(state, sessionId) === CLAUDE_AGENT_CONFIG_ID
}

const isOpen = (state: AcpState, sessionId: string): boolean => {
  const status = state.sessions[sessionId]?.status
  return status === 'active' || status === 'error'
}

/** Resolves once the chat has no turn, replay, queue or pending request; `false` if it closed. */
function waitUntilIdle(sessionId: string): Promise<boolean> {
  const check = (state: AcpState): boolean | null => {
    if (!isOpen(state, sessionId)) return false
    return switchBlockedReason(state, sessionId) === null ? true : null
  }
  const now = check(useAcpStore.getState())
  if (now !== null) return Promise.resolve(now)
  return new Promise((resolve) => {
    const unsubscribe = useAcpStore.subscribe((state) => {
      const result = check(state)
      if (result === null) return
      unsubscribe()
      resolve(result)
    })
  })
}

/** Chats with a restart already running or waiting, so a second switch does not stack. */
const restarting = new Set<string>()

/**
 * Restart one Claude chat on its Project's current Account and resume the same
 * session. `resend` sends the last user prompt again; `cancelTurn` stops a
 * turn that is still held (a usage limit can keep a turn open until reset).
 */
export async function restartClaudeSession(
  sessionId: string,
  options: { resend?: boolean; cancelTurn?: boolean } = {}
): Promise<boolean> {
  if (restarting.has(sessionId)) return false
  restarting.add(sessionId)
  try {
    const store = useAcpStore.getState()
    if (!isOpen(store, sessionId) || !isClaudeSession(store, sessionId)) return false
    if (options.cancelTurn && switchBlockedReason(store, sessionId) !== null) {
      await store.cancelPrompt(sessionId).catch(() => undefined)
    }
    if (!(await waitUntilIdle(sessionId))) return false
    const oldAgentId = useAcpStore.getState().sessions[sessionId]?.agentId
    void logFrontendError({
      level: 'info',
      source: 'claudeAccountSwitch.restart',
      message: `Restarting chat ${sessionId} on its project account (resend=${Boolean(options.resend)})`
    })
    // Stop the old process first: its reuse key goes with it, and a web reopen
    // cannot adopt it, so the reopen spawns with the new Account.
    if (oldAgentId)
      await useAcpStore
        .getState()
        .killAgent(oldAgentId)
        .catch(() => undefined)
    await useAcpStore.getState().retryCrashedSession(sessionId, { resend: options.resend ?? false })
    useAcpStore.setState((s) => {
      const usage = s.sessionUsage[sessionId]
      if (!usage?.rateLimit) return {}
      const { rateLimit: _cleared, ...rest } = usage
      return { sessionUsage: { ...s.sessionUsage, [sessionId]: rest } }
    })
    return useAcpStore.getState().sessions[sessionId]?.status === 'active'
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: 'claudeAccountSwitch.restart',
      message: `Restart of chat ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`
    })
    return false
  } finally {
    restarting.delete(sessionId)
  }
}

/**
 * Restart every open Claude chat of a Project after its Account changed.
 * `continueSessionId` is the chat that hit a limit: its held turn is cancelled
 * and its last prompt is sent again. Other busy chats restart in the
 * background when their turn ends. Resolves when the idle chats restarted.
 */
export async function applyProjectClaudeAccount(
  projectId: string,
  options: { continueSessionId?: string } = {}
): Promise<void> {
  const state = useAcpStore.getState()
  const sessionIds = Object.values(state.sessions)
    .filter((s) => s.projectId === projectId && isOpen(state, s.id) && isClaudeSession(state, s.id))
    .map((s) => s.id)
  void logFrontendError({
    level: 'info',
    source: 'claudeAccountSwitch.apply',
    message: `Project ${projectId} account changed; restarting ${sessionIds.length} Claude chats`
  })
  const now: Promise<boolean>[] = []
  for (const id of sessionIds) {
    if (id === options.continueSessionId) {
      now.push(restartClaudeSession(id, { resend: true, cancelTurn: true }))
    } else if (switchBlockedReason(state, id) === null) {
      now.push(restartClaudeSession(id))
    } else {
      void restartClaudeSession(id)
    }
  }
  await Promise.all(now)
}

/** Choose a Project's Account on the host, then restart its Claude chats on it. */
export async function switchProjectClaudeAccount(
  projectId: string,
  accountId: string | null,
  options: { continueSessionId?: string } = {}
): Promise<void> {
  await claudeAccountsApi.setProjectAccount(projectId, accountId)
  await applyProjectClaudeAccount(projectId, options)
}
