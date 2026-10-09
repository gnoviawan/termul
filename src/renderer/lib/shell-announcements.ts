/**
 * Pure derivation of the mobile shell live-region announcements.
 *
 * Everything here is a function of (previous memory, next state, context): no
 * stores, no timers, no DOM. `use-shell-announcements` feeds it from the real
 * stores; the announcer store owns delivery.
 *
 * Rules shared by every derivation:
 * - Transitions only. An announcement is the diff between the remembered state
 *   and the next one, never a restatement of the current state.
 * - The first observation of anything is a silent baseline. A null previous
 *   memory, an unknown session and an unknown channel all announce nothing.
 */

import { agentChatNeedsAttention } from '@/lib/agent-chat-attention'
import type { SessionStatus } from '@/stores/acp-store'
import type { ConnectionChannelState } from '@/stores/connection-status-store'

export const APPROVAL_NEEDED = 'Approval needed'
export const TURN_FINISHED = 'Turn finished'
export const CONNECTION_RECONNECTING = 'Reconnecting…'
export const CONNECTION_DISCONNECTED = 'Disconnected'
export const CONNECTION_CONNECTED = 'Connected'
/** Fallback chat name; matches `agentChatLabel` in `MobileChatShell`. */
export const DEFAULT_CHAT_LABEL = 'Agent Chat'

export function needsYouAnnouncement(chat: string): string {
  return `${chat} needs you`
}

export function switchingAnnouncement(project: string): string {
  return `Switching to ${project}…`
}

export function switchFailedAnnouncement(project: string): string {
  return `Couldn't switch to ${project}`
}

/** `1 chat matches` follows the spine's singular precedent; every other count is plural. */
export function chatsMatchAnnouncement(count: number): string {
  return count === 1 ? '1 chat matches' : `${count} chats match`
}

/**
 * The `agentChatLabel` chain: live session title, then the session-index
 * title, then {@link DEFAULT_CHAT_LABEL}. An empty title counts as missing so
 * an announcement never starts with a blank.
 */
export function resolveChatLabel(
  liveTitle: string | null | undefined,
  indexTitle: string | null | undefined
): string {
  return liveTitle || indexTitle || DEFAULT_CHAT_LABEL
}

// ---------------------------------------------------------------------------
// ACP: approvals, other-chat needs-you, turn finished, project switch
// ---------------------------------------------------------------------------

/** The slice of an ACP session the derivation reads. */
export interface AnnouncementSession {
  agentId: string
  projectId: string
  status: SessionStatus
  activeTurn: boolean
}

/** The slice of the ACP store the derivation reads. `AcpState` satisfies it. */
export interface AcpAnnouncementState {
  sessions: Readonly<Record<string, AnnouncementSession>>
  agentStatus: Readonly<Record<string, string | undefined>>
  pendingPermissions: Readonly<Record<string, { sessionId: string }>>
  pendingQuestions: Readonly<Record<string, { sessionId: string }>>
  pendingElicitations: Readonly<Record<string, { sessionId: string }>>
  switchingProjectId: string | null
  failedProjectSwitchId: string | null
}

/** Facts from outside the ACP store that decide who an announcement is for. */
export interface AnnouncementContext {
  /** Session id of the active pane's active `agent-chat` tab, if any. */
  activeChatId: string | null
  activeProjectId: string
  /** Open `agent-chat` tabs plus retained chats, minus ephemeral sessions. */
  candidateChatIds: ReadonlySet<string>
  /** `{chat}`: the `agentChatLabel` chain. */
  chatLabel: (sessionId: string) => string
  /** `{project}`: the project-store name, or the id when no name is found. */
  projectName: (projectId: string) => string
}

/** What the previous evaluation saw. Compared against the next state. */
export interface AcpAnnouncementMemory {
  /** Every session id present, so a session first seen is a baseline. */
  sessionIds: ReadonlySet<string>
  activeTurn: Readonly<Record<string, boolean>>
  /**
   * `agentChatNeedsAttention` per known session, not only per candidate chat. A
   * chat that becomes a candidate between two ACP writes (a tab opened) then
   * still has a previous value to diff against; only a session seen for the
   * first time is a baseline.
   */
  needsYou: Readonly<Record<string, boolean>>
  /** `permission:`, `question:` and `elicitation:` keys currently pending. */
  approvalKeys: ReadonlySet<string>
  switchingProjectId: string | null
  failedProjectSwitchId: string | null
}

export interface AnnouncementResult<M> {
  memory: M
  /** In emission order. The announcer keeps the last one, so later entries win. */
  announcements: string[]
}

/** Pending approval key to the session it belongs to. Elicitations included. */
function pendingApprovals(state: AcpAnnouncementState): Map<string, string> {
  const approvals = new Map<string, string>()
  for (const [id, item] of Object.entries(state.pendingPermissions)) {
    approvals.set(`permission:${id}`, item.sessionId)
  }
  for (const [id, item] of Object.entries(state.pendingQuestions)) {
    approvals.set(`question:${id}`, item.sessionId)
  }
  for (const [id, item] of Object.entries(state.pendingElicitations)) {
    approvals.set(`elicitation:${id}`, item.sessionId)
  }
  return approvals
}

/**
 * Needs-you per session, through the same predicate the desktop tab strip and
 * the project signals use. Elicitations are deliberately absent from it, so
 * another chat's elicitation stays silent. Every session is observed, not only
 * the current candidates: the candidate set (open tabs, retained chats) can
 * change without an ACP write, and the diff needs a previous value for a chat
 * that just became a candidate. Who is announced is decided later.
 */
function observeNeedsYou(state: AcpAnnouncementState): Record<string, boolean> {
  const permissionSessions = new Set(
    Object.values(state.pendingPermissions).map((item) => item.sessionId)
  )
  const questionSessions = new Set(
    Object.values(state.pendingQuestions).map((item) => item.sessionId)
  )
  const needsYou: Record<string, boolean> = {}
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    needsYou[sessionId] = agentChatNeedsAttention({
      projectId: session.projectId,
      sessionStatus: session.status,
      agentStatus: state.agentStatus[session.agentId],
      pendingPermission: permissionSessions.has(sessionId),
      pendingQuestion: questionSessions.has(sessionId),
      ephemeral: false
    })
  }
  return needsYou
}

/**
 * Diff the previous memory against the next ACP state.
 *
 * Emission order is switch, turn finished, needs-you, approval, so that when
 * several land together `Approval needed` is the one the announcer keeps.
 * A null `prev` returns the baseline memory and no announcements.
 */
export function deriveAcpAnnouncements(
  prev: AcpAnnouncementMemory | null,
  state: AcpAnnouncementState,
  ctx: AnnouncementContext
): AnnouncementResult<AcpAnnouncementMemory> {
  const approvals = pendingApprovals(state)
  const needsYou = observeNeedsYou(state)
  const activeTurn: Record<string, boolean> = {}
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    activeTurn[sessionId] = session.activeTurn
  }
  const memory: AcpAnnouncementMemory = {
    sessionIds: new Set(Object.keys(state.sessions)),
    activeTurn,
    needsYou,
    approvalKeys: new Set(approvals.keys()),
    switchingProjectId: state.switchingProjectId,
    failedProjectSwitchId: state.failedProjectSwitchId
  }
  if (prev === null) return { memory, announcements: [] }

  const announcements: string[] = []

  // 1. Project switch: starts, or fails (even if the failure is cleared again
  // in the same tick, because each store write is evaluated on its own).
  if (state.switchingProjectId !== null && state.switchingProjectId !== prev.switchingProjectId) {
    announcements.push(switchingAnnouncement(ctx.projectName(state.switchingProjectId)))
  }
  if (
    state.failedProjectSwitchId !== null &&
    state.failedProjectSwitchId !== prev.failedProjectSwitchId
  ) {
    announcements.push(switchFailedAnnouncement(ctx.projectName(state.failedProjectSwitchId)))
  }

  // 2. Turn finished: the active chat's own turn going true → false. Switching
  // between chats changes nothing here, because the diff is per session. A
  // `closed` session is excluded: reopening a chat installs it as `closed` with
  // an optimistic live turn and clears that flag again when no agent owns the
  // turn, so true → false there is a dead turn being cleared, not one finishing.
  const activeChatId = ctx.activeChatId
  if (
    activeChatId !== null &&
    prev.activeTurn[activeChatId] === true &&
    activeTurn[activeChatId] === false &&
    state.sessions[activeChatId]?.status !== 'closed'
  ) {
    announcements.push(TURN_FINISHED)
  }

  // 3. Needs-you: another chat in the active project goes false → true. An
  // unknown previous value is a baseline, and a chat that already needed you
  // (a second permission, or it just stopped being active) stays silent.
  for (const sessionId of ctx.candidateChatIds) {
    if (sessionId === activeChatId) continue
    const session = state.sessions[sessionId]
    if (!session || session.projectId !== ctx.activeProjectId) continue
    if (prev.needsYou[sessionId] === false && needsYou[sessionId] === true) {
      announcements.push(needsYouAnnouncement(ctx.chatLabel(sessionId)))
    }
  }

  // 4. Approval: a new pending key for the active chat. A session first seen in
  // this same evaluation is a baseline, not a new request.
  if (activeChatId !== null && prev.sessionIds.has(activeChatId)) {
    for (const [key, sessionId] of approvals) {
      if (sessionId === activeChatId && !prev.approvalKeys.has(key)) {
        announcements.push(APPROVAL_NEEDED)
        break
      }
    }
  }

  return { memory, announcements }
}

// ---------------------------------------------------------------------------
// Connection: per-channel loss and recovery
// ---------------------------------------------------------------------------

export interface ConnectionAnnouncementState {
  controlChannel: ConnectionChannelState
  terminalChannel: ConnectionChannelState
}

export interface ChannelMemory {
  state: ConnectionChannelState
  /** True after an announced loss, until the channel is connected again. */
  lost: boolean
}

export interface ConnectionAnnouncementMemory {
  control: ChannelMemory
  terminal: ChannelMemory
}

function stepChannel(
  prev: ChannelMemory,
  next: ConnectionChannelState
): { memory: ChannelMemory; announcement: string | null } {
  if (prev.state === next) return { memory: prev, announcement: null }
  switch (next) {
    case 'reconnecting':
      return {
        memory: { state: next, lost: true },
        announcement: CONNECTION_RECONNECTING
      }
    case 'disconnected':
      return {
        memory: { state: next, lost: true },
        announcement: CONNECTION_DISCONNECTED
      }
    case 'connected':
      // Recovery is announced only after an announced loss, so the boot
      // connecting → connected and the lazy terminal connect stay silent.
      return {
        memory: { state: next, lost: false },
        announcement: prev.lost ? CONNECTION_CONNECTED : null
      }
    default:
      // 'connecting' marks a fresh connect, or a retry in the middle of a loss
      // that was already announced. Silent either way; `lost` carries over.
      return { memory: { state: next, lost: prev.lost }, announcement: null }
  }
}

/** Diff the previous channel memory against the next connection state. */
export function deriveConnectionAnnouncements(
  prev: ConnectionAnnouncementMemory | null,
  state: ConnectionAnnouncementState
): AnnouncementResult<ConnectionAnnouncementMemory> {
  if (prev === null) {
    return {
      memory: {
        control: { state: state.controlChannel, lost: false },
        terminal: { state: state.terminalChannel, lost: false }
      },
      announcements: []
    }
  }
  const control = stepChannel(prev.control, state.controlChannel)
  const terminal = stepChannel(prev.terminal, state.terminalChannel)
  const announcements: string[] = []
  if (control.announcement) announcements.push(control.announcement)
  if (terminal.announcement) announcements.push(terminal.announcement)
  return { memory: { control: control.memory, terminal: terminal.memory }, announcements }
}
