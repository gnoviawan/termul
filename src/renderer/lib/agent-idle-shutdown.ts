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
