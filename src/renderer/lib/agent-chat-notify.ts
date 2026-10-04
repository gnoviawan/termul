/**
 * Decide when an Agent Chat should raise a system notification (issue #865).
 *
 * The first snapshot is silent so chats that are already waiting at startup
 * do not ping. A later busy-to-idle close pings only for a finished turn with
 * an empty prompt queue. A new permission or question pings once.
 */
import type { SessionId, StopReason } from '@/lib/acp-api'

export interface TurnEndNotice {
  seq: number
  stopReason: StopReason | null
}

export function bumpTurnEndNotice(
  notices: Record<SessionId, TurnEndNotice>,
  sessionId: SessionId,
  stopReason: StopReason | undefined
): Record<SessionId, TurnEndNotice> {
  const prev = notices[sessionId]
  return {
    ...notices,
    [sessionId]: {
      seq: (prev?.seq ?? 0) + 1,
      stopReason: stopReason ?? null
    }
  }
}

const NOTIFIABLE_STOP_REASONS = new Set<StopReason>([
  'end_turn',
  'refusal',
  'max_tokens',
  'max_turn_requests'
])

export function isNotifiableStopReason(reason: StopReason | null): boolean {
  return reason !== null && NOTIFIABLE_STOP_REASONS.has(reason)
}

export interface AgentChatNotifySession {
  projectId: string
  ephemeral: boolean
  busy: boolean
  queueLength: number
  turnEndSeq: number
  stopReason: StopReason | null
}

export interface AgentChatNotifyRequest {
  id: string
  sessionId: SessionId
}

export interface AgentChatNotifySnapshot {
  sessions: Record<SessionId, AgentChatNotifySession>
  permissions: readonly AgentChatNotifyRequest[]
  questions: readonly AgentChatNotifyRequest[]
  /** Active agent-chat tab while the window is focused. Otherwise null. */
  viewingSessionId: SessionId | null
  notifyTurnFinished: boolean
  notifyNeedsYou: boolean
}

export type AgentChatNotifyEvent =
  | { kind: 'turn-finished'; sessionId: SessionId }
  | { kind: 'needs-approval'; sessionId: SessionId; requestId: string }
  | { kind: 'has-question'; sessionId: SessionId; questionId: string }

function sessionCanNotify(
  session: AgentChatNotifySession | undefined
): session is AgentChatNotifySession {
  return Boolean(session && !session.ephemeral && session.projectId.length > 0)
}

export function decideAgentChatNotifications(
  prev: AgentChatNotifySnapshot | null,
  next: AgentChatNotifySnapshot
): AgentChatNotifyEvent[] {
  if (!prev) return []

  const events: AgentChatNotifyEvent[] = []

  if (next.notifyTurnFinished) {
    for (const [sessionId, session] of Object.entries(next.sessions)) {
      const prevSeq = prev.sessions[sessionId]?.turnEndSeq ?? 0
      if (session.turnEndSeq <= prevSeq) continue
      if (!sessionCanNotify(session)) continue
      if (session.busy || session.queueLength > 0) continue
      if (!isNotifiableStopReason(session.stopReason)) continue
      if (next.viewingSessionId === sessionId) continue
      events.push({ kind: 'turn-finished', sessionId })
    }
  }

  if (next.notifyNeedsYou) {
    const seenPermissions = new Set(prev.permissions.map((item) => item.id))
    for (const permission of next.permissions) {
      if (seenPermissions.has(permission.id)) continue
      const session = next.sessions[permission.sessionId]
      if (!sessionCanNotify(session)) continue
      if (next.viewingSessionId === permission.sessionId) continue
      events.push({
        kind: 'needs-approval',
        sessionId: permission.sessionId,
        requestId: permission.id
      })
    }

    const seenQuestions = new Set(prev.questions.map((item) => item.id))
    for (const question of next.questions) {
      if (seenQuestions.has(question.id)) continue
      const session = next.sessions[question.sessionId]
      if (!sessionCanNotify(session)) continue
      if (next.viewingSessionId === question.sessionId) continue
      events.push({
        kind: 'has-question',
        sessionId: question.sessionId,
        questionId: question.id
      })
    }
  }

  return events
}
