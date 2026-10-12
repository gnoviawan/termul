/**
 * Prompt pending-reconcile (AD-6). A prompt command whose reply is lost to a
 * transport drop has an UNKNOWN outcome — it is neither failed nor accepted.
 * The turn view stays open ("Waiting to confirm") and the SAME `turnId` is
 * resent (AD-5) until the host answers with a receipt or the stop reason, or
 * the turn resolves through its `user_prompt` echo / `prompt_complete`.
 *
 * Resends are triggered by transport recovery (reconnect, snapshot recovery)
 * and by a backoff timer that settles into a slow capped cadence (the last
 * delay repeats) for as long as the command stays pending; at most one resend
 * per session is in flight. The timer stops on an explicit host rejection, a
 * receipt/stop reason, the turn ending, or the session going away. A locally
 * raised failure (dropped socket, timeout, token halt) never fails the turn —
 * only an explicit host error reply does.
 * Never logs prompt content — only session/turn ids and counts.
 */

import type { PromptDispatchResult, SessionId } from '@/lib/acp-api'
import { isPendingPromptTransportError } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { dropRecordKey } from '../helpers'
import { useAcpStore } from '../index'
import {
  activeWirePromptTurns,
  claimPromptTurnEnd,
  type PendingPromptCommand,
  pendingPromptCommands
} from '../shared-state'

/**
 * Backoff between timer-driven resends. Once the ladder is spent the LAST
 * delay repeats as the slow cap, so a command that never gets an answer keeps
 * being retried (still deduped, one in flight) instead of waiting for a
 * recovery event that may never come.
 */
export const PROMPT_RECONCILE_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000]

export interface PromptReconcileHandlers {
  turnId: string
  resend: () => Promise<PromptDispatchResult>
  /** The host answered the resend (stop reason ⇒ the turn ran on this call). */
  onResult: (result: PromptDispatchResult) => void
  /** The host explicitly rejected the resend — a definite failure. */
  onDefiniteFailure: (err: unknown) => void
}

function setReconcileFlag(sessionId: SessionId, pending: boolean): void {
  useAcpStore.setState((s) => {
    const has = Boolean(s.pendingPromptReconcile[sessionId])
    if (has === pending) return {}
    return {
      pendingPromptReconcile: pending
        ? { ...s.pendingPromptReconcile, [sessionId]: true as const }
        : dropRecordKey(s.pendingPromptReconcile, sessionId)
    }
  })
}

function armRetryTimer(sessionId: SessionId, cmd: PendingPromptCommand): void {
  clearTimeout(cmd.timer)
  cmd.timer = undefined
  const delay =
    PROMPT_RECONCILE_RETRY_DELAYS_MS[
      Math.min(cmd.attempts, PROMPT_RECONCILE_RETRY_DELAYS_MS.length - 1)
    ]
  cmd.timer = setTimeout(() => {
    cmd.timer = undefined
    if (pendingPromptCommands.get(sessionId) !== cmd) return
    // A reconnect in flight resends on its own completion — don't race it,
    // but keep the cadence alive in case that cycle ends without recovery.
    if (useAcpStore.getState().transportReconnecting) {
      armRetryTimer(sessionId, cmd)
      return
    }
    cmd.attempts += 1
    runResend(sessionId, cmd)
  }, delay)
}

/** A resend that outlived Stop has settled: let the caller cancel again. */
function settleCancelled(cmd: PendingPromptCommand): boolean {
  if (!cmd.cancelled) return false
  const after = cmd.afterCancelSettled
  cmd.afterCancelSettled = undefined
  after?.()
  return true
}

function runResend(sessionId: SessionId, cmd: PendingPromptCommand): void {
  if (cmd.inFlight || cmd.cancelled) return
  const session = useAcpStore.getState().sessions[sessionId]
  if (
    !session ||
    (session.status === 'closed' && !useAcpStore.getState().openingHistoryIds[sessionId])
  ) {
    clearPromptReconcile(sessionId)
    return
  }
  cmd.inFlight = true
  clearTimeout(cmd.timer)
  cmd.timer = undefined
  let resending: Promise<PromptDispatchResult>
  try {
    resending = cmd.resend()
  } catch (err) {
    resending = Promise.reject(err)
  }
  void resending.then(
    (result) => {
      cmd.inFlight = false
      if (settleCancelled(cmd)) return
      if (pendingPromptCommands.get(sessionId) !== cmd) return
      clearPromptReconcile(sessionId)
      cmd.onResult(result)
    },
    (err: unknown) => {
      cmd.inFlight = false
      if (settleCancelled(cmd)) return
      if (pendingPromptCommands.get(sessionId) !== cmd) return
      // Dropped socket / timeout / local token halt: the host never answered,
      // so the outcome is still unknown — keep waiting, never fail the turn.
      if (isPendingPromptTransportError(err)) {
        armRetryTimer(sessionId, cmd)
        return
      }
      clearPromptReconcile(sessionId)
      void logFrontendError({
        level: 'warn',
        source: 'acp-store.promptReconcile',
        message: `Resend of prompt turn ${cmd.turnId} on session ${sessionId} was rejected: ${String(err)}`
      })
      cmd.onDefiniteFailure(err)
    }
  )
}

/**
 * Move a prompt command to pending-reconcile: the transport dropped before a
 * reply. Keeps the turn open and schedules a same-`turnId` resend.
 */
export function beginPromptReconcile(
  sessionId: SessionId,
  handlers: PromptReconcileHandlers
): void {
  const previous = pendingPromptCommands.get(sessionId)
  if (previous) clearTimeout(previous.timer)
  const cmd: PendingPromptCommand = {
    ...handlers,
    attempts: 0,
    timer: undefined,
    inFlight: false
  }
  pendingPromptCommands.set(sessionId, cmd)
  setReconcileFlag(sessionId, true)
  void logFrontendError({
    level: 'warn',
    source: 'acp-store.promptReconcile',
    message: `Prompt turn ${handlers.turnId} on session ${sessionId} lost its reply; waiting to confirm and resending the same turn id`
  })
  armRetryTimer(sessionId, cmd)
}

/** Resolve the pending command (answered, echoed, completed, failed, cancelled). */
export function clearPromptReconcile(sessionId: SessionId): void {
  const cmd = pendingPromptCommands.get(sessionId)
  if (cmd) {
    clearTimeout(cmd.timer)
    pendingPromptCommands.delete(sessionId)
  }
  setReconcileFlag(sessionId, false)
}

/**
 * Stop on a prompt that is still waiting to confirm: the user abandoned it.
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
  const cmd = pendingPromptCommands.get(sessionId)
  if (!cmd) return false
  cmd.cancelled = true
  if (cmd.inFlight) cmd.afterCancelSettled = afterInFlightSettles
  clearPromptReconcile(sessionId)
  claimPromptTurnEnd(cmd.turnId)
  if (activeWirePromptTurns.get(sessionId) === cmd.turnId) activeWirePromptTurns.delete(sessionId)
  return true
}

/** Resolve the pending command only when it belongs to `turnId`. */
export function clearPromptReconcileForTurn(sessionId: SessionId, turnId: string): void {
  if (pendingPromptCommands.get(sessionId)?.turnId === turnId) clearPromptReconcile(sessionId)
}

/**
 * Transport recovery (reconnect finished / snapshot installed): resend every
 * pending command now, or just `sessionId`'s. Deduped — a session with a
 * resend already in flight is skipped.
 */
export function resendPendingPrompts(sessionId?: SessionId): void {
  const targets = sessionId
    ? [...pendingPromptCommands].filter(([id]) => id === sessionId)
    : [...pendingPromptCommands]
  for (const [id, cmd] of targets) runResend(id, cmd)
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
