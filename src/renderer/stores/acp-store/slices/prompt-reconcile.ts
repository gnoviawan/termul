/**
 * Prompt pending-reconcile (AD-6): the prompt-specific adapter over the generic
 * command engine (`lib/command-engine.ts`). A prompt command whose reply is
 * lost to a transport drop has an UNKNOWN outcome — it is neither failed nor
 * accepted. The turn view stays open ("Waiting to confirm") and the SAME
 * `turnId` (the prompt's `commandId`, AD-5) is resent until the host answers
 * with a receipt or the stop reason, or the turn resolves through its
 * `user_prompt` echo / `prompt_complete`.
 *
 * The engine owns the ladder, the one-resend-in-flight dedupe, the
 * `transportReconnecting` guard and the `outcome_unknown` hold; this module
 * binds it to the store: it publishes the per-session command state
 * (`promptCommandStates`), resolves the command from the recovered log, and
 * implements Stop (abandon).
 * Never logs prompt content — only session/turn ids and counts.
 */

import type { PromptDispatchResult, SessionId } from '@/lib/acp-api'
import {
  abandonDetached,
  beginDetachedCommand,
  dropDetached,
  dropDetachedForCommand,
  recheckDetached,
  resendDetached
} from '@/lib/command-engine'
import { dropRecordKey } from '../helpers'
import { useAcpStore } from '../index'
import { activeWirePromptTurns, claimPromptTurnEnd } from '../shared-state'
import type { PromptCommandState } from '../types'

export interface PromptReconcileHandlers {
  /** The prompt's wire `turnId` — its `commandId` (AD-5). */
  turnId: string
  resend: () => Promise<PromptDispatchResult>
  /** The host answered the resend (stop reason ⇒ the turn ran on this call). */
  onResult: (result: PromptDispatchResult) => void
  /** The host explicitly rejected the resend — a definite failure. */
  onDefiniteFailure: (err: unknown) => void
  /** The dispatch's own answer was `outcome_unknown` (hold: no auto-resend). */
  outcomeUnknown?: boolean
}

function publishState(sessionId: SessionId, state: PromptCommandState | null): void {
  useAcpStore.setState((s) => {
    if (state === null) {
      return s.promptCommandStates[sessionId]
        ? { promptCommandStates: dropRecordKey(s.promptCommandStates, sessionId) }
        : {}
    }
    return { promptCommandStates: { ...s.promptCommandStates, [sessionId]: state } }
  })
}

/**
 * Move a prompt command to pending-reconcile: the transport dropped before a
 * reply. Keeps the turn open and schedules a same-`turnId` resend.
 */
export function beginPromptReconcile(
  sessionId: SessionId,
  handlers: PromptReconcileHandlers
): void {
  beginDetachedCommand<PromptDispatchResult>({
    scope: sessionId,
    commandId: handlers.turnId,
    kind: 'send_prompt',
    entityKey: sessionId,
    resend: handlers.resend,
    onResult: handlers.onResult,
    onDefiniteFailure: handlers.onDefiniteFailure,
    outcomeUnknown: handlers.outcomeUnknown,
    isGone: () => {
      const state = useAcpStore.getState()
      const session = state.sessions[sessionId]
      return !session || (session.status === 'closed' && !state.openingHistoryIds[sessionId])
    },
    isBlocked: () => useAcpStore.getState().transportReconnecting,
    onChange: (state) => publishState(sessionId, state)
  })
}

/** Resolve the pending command (answered, echoed, completed, failed, cancelled). */
export function clearPromptReconcile(sessionId: SessionId): void {
  dropDetached(sessionId, 'accepted')
  // The engine only publishes for commands it holds; drop a stale projection.
  if (useAcpStore.getState().promptCommandStates[sessionId]) publishState(sessionId, null)
}

/**
 * Stop on a prompt that is still waiting to be confirmed: the user abandoned it.
 * The command is marked cancelled (no resend may dispatch it again) and the
 * turn id is claimed as ended, so a late host `prompt_complete` for it is
 * recognised as stale and cannot end a newer open turn. A resend already in
 * flight may still start the turn on the host: `afterInFlightSettles` runs
 * once it settles so the caller can send `cancel_prompt` again.
 * Returns whether a pending command existed.
 */
export function abandonPendingPrompt(
  sessionId: SessionId,
  afterInFlightSettles: () => void
): boolean {
  const turnId = abandonDetached(sessionId, afterInFlightSettles)
  if (!turnId) return false
  claimPromptTurnEnd(turnId)
  if (activeWirePromptTurns.get(sessionId) === turnId) activeWirePromptTurns.delete(sessionId)
  return true
}

/** Resolve the pending command only when it belongs to `turnId`. */
export function clearPromptReconcileForTurn(sessionId: SessionId, turnId: string): void {
  dropDetachedForCommand(sessionId, turnId)
}

/**
 * Transport recovery (reconnect finished / snapshot installed): resend every
 * pending command now, or just `sessionId`'s. Deduped — a session with a
 * resend already in flight is skipped, and so is a command the host reported
 * as outcome-unknown (only {@link recheckPendingPrompt} asks again).
 */
export function resendPendingPrompts(sessionId?: SessionId): void {
  resendDetached(sessionId)
}

/** Manual re-check: resend the SAME turn id now, whatever the command's state. */
export function recheckPendingPrompt(sessionId: SessionId): boolean {
  return recheckDetached(sessionId)
}

/** Raw snapshot record the recovery path hands over (`WsEvent` shape). */
export interface RecoveryEventLike {
  type: string
  payload: unknown
}

function payloadField(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null && key in payload
    ? (payload as Record<string, unknown>)[key]
    : undefined
}

/**
 * Snapshot recovery (resubscribe after a stale/dropped socket) installed the
 * session's transcript. Resolve this client's open prompt turn from it: the
 * turn's terminator ends the turn, its `user_prompt` echo proves acceptance,
 * and otherwise a pending command is resent right away (same turn id).
 */
export function reconcilePromptAfterRecovery(
  sessionId: SessionId,
  events: readonly RecoveryEventLike[]
): void {
  const wireTurnId = activeWirePromptTurns.get(sessionId)
  if (!wireTurnId) return
  const session = useAcpStore.getState().sessions[sessionId]
  if (!session) return
  let accepted = false
  for (const event of events) {
    if (payloadField(event.payload, 'turnId') !== wireTurnId) continue
    if (event.type === 'prompt_complete') {
      const stopReason = payloadField(event.payload, 'stopReason')
      useAcpStore.getState()._onPromptComplete({
        agentId: session.agentId,
        sessionId,
        stopReason: typeof stopReason === 'string' ? stopReason : 'end_turn',
        turnId: wireTurnId
      })
      return
    }
    if (event.type === 'user_prompt') accepted = true
  }
  if (accepted) clearPromptReconcileForTurn(sessionId, wireTurnId)
  else resendPendingPrompts(sessionId)
}
