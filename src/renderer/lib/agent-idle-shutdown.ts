/**
 * Decide when a live ACP agent process can stop.
 *
 * `closeSession` ends one chat inside the process. `killAgent` is the call
 * that stops the Node/CLI process. A warm process (project prewarm) and a
 * chat whose tab was closed both used to skip that call.
 */

/** Stop a connected agent after this much time with no turn, prompt, or permission. */
export const AGENT_IDLE_SHUTDOWN_MS = 30 * 60 * 1000

/** How often the app checks the idle clock. */
export const AGENT_IDLE_CHECK_MS = 60 * 1000

export interface AgentBusySession {
  id: string
  agentId: string
  activeTurn: boolean
  openTurnId: string | null
  replaying?: 'pending' | 'streaming' | null
}

export interface AgentBusyInput {
  agentId: string
  agentStatus: string | undefined
  sessions: AgentBusySession[]
  pendingPermissionAgentIds: readonly string[]
  pendingQuestionAgentIds: readonly string[]
  pendingBrowserAuthAgentIds: readonly string[]
  launchingSessionIds: ReadonlySet<string>
  /** Sessions that still have prompts waiting to send. */
  queuedPromptSessionIds?: ReadonlySet<string>
  /** True while this process is inside `prepareChat` / `startChat`. */
  preparing?: boolean
}

/** True while the process is starting, streaming, waiting on the user, or replaying history. */
export function isAgentBusy(input: AgentBusyInput): boolean {
  if (input.agentStatus === 'spawning') return true
  if (input.pendingBrowserAuthAgentIds.includes(input.agentId)) return true
  if (input.pendingPermissionAgentIds.includes(input.agentId)) return true
  if (input.pendingQuestionAgentIds.includes(input.agentId)) return true
  if (input.preparing) return true
  return input.sessions.some(
    (session) =>
      session.agentId === input.agentId &&
      (session.activeTurn ||
        session.openTurnId != null ||
        session.replaying != null ||
        input.launchingSessionIds.has(session.id) ||
        input.queuedPromptSessionIds?.has(session.id) === true)
  )
}

export interface IdleAgentCandidate {
  id: string
  status: string
  busy: boolean
  /** Epoch ms of the last moment this process was busy, or when it was first seen. */
  lastBusyAt: number
  /** Chat tabs still showing a session of this process. An open tab is not idle. */
  openChatTabs?: number
}

/**
 * Connected agents with no open chat tab whose idle clock has reached `idleMs`.
 * Busy agents stay up. An open tab stays up so the composer is not disabled.
 */
export function selectAgentsPastIdle(
  agents: readonly IdleAgentCandidate[],
  now: number,
  idleMs: number = AGENT_IDLE_SHUTDOWN_MS
): string[] {
  return agents
    .filter(
      (agent) =>
        agent.status === 'connected' &&
        !agent.busy &&
        (agent.openChatTabs ?? 0) === 0 &&
        now - agent.lastBusyAt >= idleMs
    )
    .map((agent) => agent.id)
}

export interface PreparedAgentSession {
  status: string
  ephemeral: boolean
  activeTurn: boolean
  openTurnId: string | null
  replaying?: 'pending' | 'streaming' | null
  launching: boolean
  queuedPrompt: boolean
}

/**
 * The user left a project that was still on the agent entrance.
 * Stop the prewarmed process. Keep it when a real chat, turn, or prompt exists.
 */
export function shouldStopPreparedAgentOnProjectLeave(input: {
  openChatTabs: number
  pendingPermission: boolean
  pendingQuestion: boolean
  pendingBrowserAuth: boolean
  sessions: readonly PreparedAgentSession[]
}): boolean {
  if (input.openChatTabs > 0) return false
  if (input.pendingPermission || input.pendingQuestion || input.pendingBrowserAuth) return false
  for (const session of input.sessions) {
    if (session.status === 'closed') continue
    if (
      session.activeTurn ||
      session.openTurnId != null ||
      session.replaying != null ||
      session.launching ||
      session.queuedPrompt
    ) {
      return false
    }
    if (!session.ephemeral) return false
  }
  return true
}

/**
 * A dead (or absent) agent process can never emit `prompt_complete`, so its
 * stale busy flags must not hold a chat open on close. Only a `connected`
 * (or still-`spawning`) process can finish work.
 */
export function agentCanStillFinishWork(status: string | undefined): boolean {
  return status === 'connected' || status === 'spawning'
}

/**
 * Close during a turn keeps the Agent chat open (Closing) until the turn
 * finishes. An idle chat closes now.
 */
export function agentChatCloseAction(busy: boolean): 'close-now' | 'closing' {
  return busy ? 'closing' : 'close-now'
}

/**
 * A queued prompt does not keep a Closing chat alive after the current turn.
 * A chat whose agent died while Closing finishes too — the dead process can
 * never produce the turn end the chat is waiting on.
 */
export function closingTurnStillRunning(input: AgentBusyInput): boolean {
  // A launch in flight is exempt from the liveness gate only while it can
  // still land: a placeholder session (no agent id to look up — the arriving
  // agent CAN finish work) or a session whose agent is still alive. A stale
  // marker on a dead agent is not a launch — `isAgentBusy`'s unconditional
  // `launchingSessionIds` evidence must not hold the Closing state forever.
  const canFinish = agentCanStillFinishWork(input.agentStatus)
  const launching = input.sessions.some(
    (session) =>
      session.agentId === input.agentId &&
      input.launchingSessionIds.has(session.id) &&
      (!session.agentId || canFinish)
  )
  if (!launching && !canFinish) return false
  return isAgentBusy({ ...input, queuedPromptSessionIds: undefined })
}

/**
 * A session that left the visible workspace is still an open Agent chat when
 * the user only switched Projects. The retained set is that record.
 */
export function disappearedChatIsStillOpen(
  sessionId: string,
  retainedSessionIds: ReadonlySet<string>
): boolean {
  return retainedSessionIds.has(sessionId)
}

/** Open Agent chats for one process, counting a session once across the visible tree and retained Projects. */
export function openChatCountForAgent(input: {
  agentId: string
  chats: readonly { sessionId: string; agentId: string | undefined }[]
}): number {
  const seen = new Set<string>()
  let count = 0
  for (const chat of input.chats) {
    if (chat.agentId !== input.agentId || seen.has(chat.sessionId)) continue
    seen.add(chat.sessionId)
    count += 1
  }
  return count
}

export type TabCloseShutdown = 'kill' | 'reap-when-idle' | 'keep'

/**
 * Last visible chat tab for this process just closed.
 * A running turn stays until it finishes (`reap-when-idle`). Another open tab keeps the process.
 */
export function shutdownAfterLastChatTabClose(input: {
  status: string | undefined
  busy: boolean
  remainingOpenChatTabs: number
}): TabCloseShutdown {
  if (input.status !== 'connected') return 'keep'
  if (input.remainingOpenChatTabs > 0) return 'keep'
  if (input.busy) return 'reap-when-idle'
  return 'kill'
}
