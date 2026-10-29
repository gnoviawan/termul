/**
 * Account switch for Claude Agent chats (ADR-0004): after a Project's Claude
 * Account changes, each open Claude chat of that Project restarts on a fresh
 * agent process (which the host starts with the new Account) and resumes the
 * same session. Idle chats restart at once; busy chats after their turn ends.
 * A chat stopped by a usage limit can cancel its held turn and send the last
 * prompt again on the new Account. When the new Account cannot resume the
 * session, the chat continues in a new session with a summary handoff.
 */

import { toast } from 'sonner'
import { resumeMissesSession } from '@/lib/acp-resume-policy'
import { claudeAccountsApi } from '@/lib/claude-accounts-api'
import { logFrontendError } from '@/lib/log-api'
import {
  type AcpState,
  lastOwnUserPromptBlocks,
  renewAgentCredentials,
  switchBlockedReason,
  useAcpStore
} from '@/stores/acp-store'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { getAgentChatSessionIdsInAllTrees, useWorkspaceStore } from '@/stores/workspace-store'

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

function openChatIds(): Set<string> {
  const ids = getAgentChatSessionIdsInAllTrees(useWorkspaceStore.getState())
  for (const kept of Object.values(useAgentChatLifetimeStore.getState().retainedByProject)) {
    for (const id of kept) ids.add(id)
  }
  return ids
}

/** Whether this client has the chat open: a tab, or kept for its off-screen Project. */
export const isChatOpenHere = (sessionId: string): boolean => openChatIds().has(sessionId)

async function stopOldAgent(agentId: string, reason: string): Promise<void> {
  void logFrontendError({
    level: 'info',
    source: 'claudeAccountSwitch.stop',
    message: `Stopping agent ${agentId} (${reason}) without reopening its chats`
  })
  await useAcpStore
    .getState()
    .killAgent(agentId)
    .catch((error) => {
      void logFrontendError({
        level: 'warn',
        source: 'claudeAccountSwitch.stop',
        message: `Stopping agent ${agentId} failed: ${error instanceof Error ? error.message : String(error)}`
      })
    })
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

/**
 * The new Account has no copy of the session (on Windows its config directory
 * may not share `projects`): continue the chat in a new session that starts
 * from a summary, the same handoff as an agent switch (ADR-0004 fallback).
 */
async function continueInNewSession(sessionId: string, resend: boolean): Promise<void> {
  void logFrontendError({
    level: 'warn',
    source: 'claudeAccountSwitch.handoff',
    message: `The account cannot resume chat ${sessionId}; continuing in a new session (resend=${resend})`
  })
  toast.info('This account could not resume the chat', {
    description: 'The chat continues in a new session that starts from a summary.'
  })
  const store = useAcpStore.getState()
  const blocks = resend ? lastOwnUserPromptBlocks(store.messages[sessionId] ?? []) : null
  await store.switchAgent(
    sessionId,
    CLAUDE_AGENT_CONFIG_ID,
    blocks ? { wireBlocks: blocks, displayBlocks: blocks } : undefined
  )
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
    if (!openChatIds().has(sessionId)) {
      if (oldAgentId) await stopOldAgent(oldAgentId, `turn of unopened chat ${sessionId} ended`)
      return false
    }
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
    const resend = options.resend ?? false
    try {
      await useAcpStore.getState().retryCrashedSession(sessionId, { resend })
    } catch (error) {
      const stopped = useAcpStore.getState().sessions[sessionId]?.status === 'closed'
      if (!stopped || !resumeMissesSession(error)) throw error
      await continueInNewSession(sessionId, resend)
    }
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
 * Restart every open Claude chat of a Project after its Account changed: a
 * chat with a tab, or one kept for its Project while that Project is off
 * screen. `continueSessionIds` are the chats that hit a limit: their held
 * turns are cancelled and their last prompts are sent again. Other busy chats restart in the
 * background when their turn ends. An unopened chat (a warm-pool seed, or a
 * chat whose tab was closed) is not reopened; its agent stops, after the
 * running turn if there is one, unless an open chat shares it. The Project's
 * Claude warm sessions are prepared again on the new Account. Resolves when
 * the idle chats restarted, with the `continueSessionIds` that did continue.
 */
export async function applyProjectClaudeAccount(
  projectId: string,
  options: { continueSessionIds?: readonly string[]; credentialsRenewed?: boolean } = {}
): Promise<string[]> {
  if (!options.credentialsRenewed) renewAgentCredentials(CLAUDE_AGENT_CONFIG_ID, projectId)
  const state = useAcpStore.getState()
  const openIds = openChatIds()
  const chats = Object.values(state.sessions).filter(
    (s) => s.projectId === projectId && isOpen(state, s.id) && isClaudeSession(state, s.id)
  )
  const open = chats.filter((s) => openIds.has(s.id))
  const openAgents = new Set(open.map((s) => s.agentId))
  const unopened = chats.filter((s) => !openIds.has(s.id) && !openAgents.has(s.agentId))
  const busy = unopened.filter((s) => switchBlockedReason(state, s.id) !== null)
  const busyAgents = new Set(busy.map((s) => s.agentId))
  const idleAgents = new Set(unopened.map((s) => s.agentId).filter((a) => !busyAgents.has(a)))
  const warm = new Set(Object.values(state.preparedSessions))
  const rewarmCwds = new Set<string>()
  for (const [key, sessionId] of Object.entries(state.preparedSessions)) {
    const [configId, cwd, mcpKey] = key.split('\0')
    if (configId !== CLAUDE_AGENT_CONFIG_ID || mcpKey || !cwd) continue
    if (state.sessions[sessionId]?.projectId === projectId) rewarmCwds.add(cwd)
  }
  void logFrontendError({
    level: 'info',
    source: 'claudeAccountSwitch.apply',
    message: `Project ${projectId} account changed; restarting ${open.length} open Claude chats, stopping ${idleAgents.size} agents of unopened chats now (${unopened.filter((s) => warm.has(s.id)).length} warm-pool) and ${busy.length} after their turn, preparing ${rewarmCwds.size} warm sessions again`
  })
  const now: Promise<unknown>[] = []
  const continued: string[] = []
  for (const agentId of idleAgents) now.push(stopOldAgent(agentId, 'chat not open'))
  for (const { id, agentId } of busy) {
    void logFrontendError({
      level: 'info',
      source: 'claudeAccountSwitch.stop',
      message: `Agent ${agentId} of unopened chat ${id} stops after its running turn`
    })
    void restartClaudeSession(id)
  }
  for (const cwd of rewarmCwds) {
    useAcpStore
      .getState()
      .prepareChat(CLAUDE_AGENT_CONFIG_ID, cwd, undefined, projectId, { silent: true })
  }
  for (const { id } of open) {
    if (options.continueSessionIds?.includes(id)) {
      now.push(
        restartClaudeSession(id, { resend: true, cancelTurn: true }).then((ok) => {
          if (ok) continued.push(id)
        })
      )
    } else if (switchBlockedReason(state, id) === null) {
      now.push(restartClaudeSession(id))
    } else {
      void restartClaudeSession(id)
    }
  }
  await Promise.all(now)
  return continued
}

/**
 * Choose a Project's Account on the host, then restart its Claude chats on it.
 * Agents already spawned for the Project stop taking new chats before the
 * host write, so a chat started during the switch never lands on the old
 * Account. With `expectedAccountId` the host applies the choice only while
 * the Project still uses that Account; when another client switched first,
 * nothing restarts and this resolves `null`. Otherwise it resolves with the
 * `continueSessionIds` that did continue.
 */
export async function switchProjectClaudeAccount(
  projectId: string,
  accountId: string | null,
  options: { continueSessionIds?: readonly string[]; expectedAccountId?: string } = {}
): Promise<string[] | null> {
  renewAgentCredentials(CLAUDE_AGENT_CONFIG_ID, projectId)
  const applied = await claudeAccountsApi.setProjectAccount(projectId, accountId, {
    expectedAccountId: options.expectedAccountId
  })
  if (!applied) return null
  return applyProjectClaudeAccount(projectId, {
    continueSessionIds: options.continueSessionIds,
    credentialsRenewed: true
  })
}
