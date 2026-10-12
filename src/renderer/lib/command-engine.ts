/**
 * Client command state machine (AD-5/AD-6), shared by every ledgered mutating
 * command.
 *
 *   pending ──► accepted            the host answered ok (a receipt included)
 *          ├──► rejected            the host answered with a DEFINITE error
 *          └──► pending-reconcile   the answer was lost or is unknowable:
 *                                   transport drop / timeout / token halt,
 *                                   `outcome_unknown`, `command_in_progress`
 *
 * A transport loss never yields `rejected`. A command in `pending` or
 * `pending-reconcile` is retried with the SAME `commandId` (the host resolves a
 * same-id resend by entity lookup or its ledger and never runs it twice); a
 * retry of a `rejected` command is a new intent and mints a NEW id. A receipt
 * resolves COMMAND state only — entity state follows the event stream.
 *
 * Two drivers sit on this table:
 *
 * - {@link runCommand}: an awaited call (create/load/close/...). Uncertain
 *   outcomes are resent with the same id on a short bounded ladder; if the
 *   ladder is spent the uncertain error reaches the caller and the id stays in
 *   the journal so the caller's next try of the same intent reuses it.
 * - {@link beginDetachedCommand}: a command whose caller already moved on (a
 *   prompt turn waiting to confirm). Resends run until the command resolves —
 *   backoff timer, transport recovery, manual re-check.
 *
 * Never logs payloads or credentials — only kinds, ids and counts.
 */

import { WS_ERROR_CODES } from '@shared/types/web-protocol.types'
import {
  AcpTransportError,
  COMMAND_ACCEPTED_CODE,
  type CommandCallOptions,
  isOutcomeUncertainError
} from './acp-transport/types'
import {
  findUnresolvedCommand,
  keyDigest,
  listUnresolvedCommands,
  markOutcomeUnknown,
  openCommand,
  resolveCommand
} from './command-journal'
import { logFrontendError } from './log-api'

export type CommandPhase = 'pending' | 'accepted' | 'rejected' | 'pending-reconcile'

/** Observable state of one command. Never carries a payload. */
export interface CommandState {
  commandId: string
  kind: string
  entityKey: string
  phase: CommandPhase
  /**
   * The host reported `outcome_unknown`: it no longer knows whether the
   * command ran, and it will not run it again. The command stays
   * pending-reconcile ("outcome unknown — check") until a manual same-id
   * re-check or a new intent.
   */
  outcomeUnknown: boolean
  /** Sends made so far with this id. */
  attempts: number
  visibleAt?: number
  /** A manual same-id re-check is in flight (the UI shows "Checking…"). */
  checking?: boolean
}

/**
 * Backoff between timer-driven resends of a detached command. Once the ladder
 * is spent the LAST delay repeats as the slow cap, so a command that never
 * gets an answer keeps being retried (still deduped, one in flight) instead
 * of waiting for a recovery event that may never come.
 */
export const COMMAND_RESEND_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000, 15_000]

/** Same-id resends an awaited command makes before the caller sees the error. */
export const AWAITED_RESEND_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000]

/** Resolved states kept for observation; unresolved ones are never evicted. */
const MAX_RESOLVED_STATES = 100

const commandStates = new Map<string, CommandState>()
/** Ids an awaiting `runCommand` is currently using: a concurrent try is a different command. */
const activeRuns = new Set<string>()

function setState(state: CommandState): CommandState {
  commandStates.delete(state.commandId)
  commandStates.set(state.commandId, state)
  if (commandStates.size > MAX_RESOLVED_STATES) {
    for (const [id, existing] of commandStates) {
      if (commandStates.size <= MAX_RESOLVED_STATES) break
      if (existing.phase === 'accepted' || existing.phase === 'rejected') commandStates.delete(id)
    }
  }
  return state
}

/** The current state of a command this page knows about. */
export function getCommandState(commandId: string): CommandState | undefined {
  return commandStates.get(commandId)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof AcpTransportError ? error.code : undefined
}

/** The host no longer knows whether the command ran (and will not run it again). */
function isOutcomeUnknown(error: unknown): boolean {
  return errorCode(error) === WS_ERROR_CODES.OUTCOME_UNKNOWN
}

/** Resolve a command: record the phase and drop its journal entry. */
function resolveState(state: CommandState, phase: 'accepted' | 'rejected'): CommandState {
  resolveCommand(state.commandId)
  return setState({ ...state, phase, outcomeUnknown: false })
}

function warn(source: string, message: string): void {
  void logFrontendError({ level: 'warn', source, message })
}

/**
 * Resolve a command a caller drives itself (the prompt turn's first dispatch):
 * records the phase and drops its journal entry.
 */
export function settleCommand(commandId: string, phase: 'accepted' | 'rejected'): void {
  const state = commandStates.get(commandId)
  if (state) resolveState(state, phase)
  else resolveCommand(commandId)
}

// --- Awaited commands --------------------------------------------------------

export interface RunCommandOptions<T> {
  /** The request type the command is (e.g. `create_session`). */
  kind: string
  /**
   * What the command acts on (identifiers only — never a payload). A retry of
   * the same intent finds its unresolved id by `kind` + `entityKey`.
   */
  entityKey: string
  /** Issue the command with the call options (`commandId`, `onVisibleAt`). */
  send: (call: CommandCallOptions) => Promise<T>
  /**
   * The result for a `command_accepted` verdict (the command ran; its reply is
   * not retained). Omit when the caller needs the reply: the verdict then
   * surfaces as an error AFTER the command is resolved as accepted.
   */
  acceptedWithoutResult?: () => T
  /**
   * Never reuse an unresolved id from an earlier call (the in-call resend
   * ladder still reuses its own). For commands whose request carries content
   * the key cannot name — a retry may be a different request (credentials).
   */
  fresh?: boolean
  /** Test seam: resend delays (default {@link AWAITED_RESEND_DELAYS_MS}). */
  delaysMs?: readonly number[]
}

export interface CommandRun<T> {
  result: T
  commandId: string
  /** True when this call reused an unresolved id (the host may answer by lookup). */
  resent: boolean
  /** The reply's `visible_at` session seq, when it carried one. */
  visibleAt?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The id a new run of `kind`/`entityKey` uses: the unresolved one when its
 * outcome is merely uncertain, else a freshly minted (and persisted) one. An
 * `outcome_unknown` command is not reused — the host would answer the same
 * way forever. For an AWAITED command the user's next try IS the resolution of
 * that unknown outcome: a new intent with a new id (the flag is persisted, so
 * this holds across a reload). The stale entry is dropped.
 */
function claimCommandId(
  kind: string,
  entityKey: string,
  fresh: boolean
): { commandId: string; reused: boolean } {
  const unresolved = fresh ? null : findUnresolvedCommand(kind, entityKey, Date.now(), activeRuns)
  if (unresolved && !unresolved.outcomeUnknown) {
    return { commandId: unresolved.commandId, reused: true }
  }
  if (unresolved) resolveCommand(unresolved.commandId)
  return { commandId: openCommand(kind, entityKey).commandId, reused: false }
}

/** A newer accepted outcome supersedes older unresolved ids of the same intent. */
function dropSuperseded(kind: string, entityKey: string, keep: string): void {
  for (const entry of listUnresolvedCommands()) {
    if (
      entry.kind === kind &&
      entry.entityKey === keyDigest(entityKey) &&
      entry.commandId !== keep &&
      // A concurrent run's id must stay journaled until that run resolves.
      !activeRuns.has(entry.commandId)
    ) {
      resolveCommand(entry.commandId)
    }
  }
}

/**
 * Run an awaited ledgered command. The id is persisted before the first send;
 * uncertain outcomes are resent with the same id; a definite rejection ends
 * the command (the next try mints a new id).
 */
export async function runCommand<T>(options: RunCommandOptions<T>): Promise<CommandRun<T>> {
  const { commandId, reused } = claimCommandId(
    options.kind,
    options.entityKey,
    options.fresh === true
  )
  activeRuns.add(commandId)
  try {
    return await runClaimed(options, commandId, reused)
  } finally {
    activeRuns.delete(commandId)
  }
}

async function runClaimed<T>(
  options: RunCommandOptions<T>,
  commandId: string,
  reused: boolean
): Promise<CommandRun<T>> {
  const { kind, entityKey } = options
  const delays = options.delaysMs ?? AWAITED_RESEND_DELAYS_MS
  let state = setState({
    commandId,
    kind,
    entityKey,
    phase: 'pending',
    outcomeUnknown: false,
    attempts: 0
  })
  let visibleAt: number | undefined
  for (let attempt = 0; ; attempt++) {
    state = setState({ ...state, phase: 'pending', attempts: state.attempts + 1 })
    try {
      const result = await options.send({
        commandId,
        onVisibleAt: (value) => {
          visibleAt = value
        }
      })
      resolveState({ ...state, ...(visibleAt !== undefined ? { visibleAt } : {}) }, 'accepted')
      dropSuperseded(kind, entityKey, commandId)
      return {
        result,
        commandId,
        resent: reused || attempt > 0,
        ...(visibleAt !== undefined ? { visibleAt } : {})
      }
    } catch (error) {
      if (errorCode(error) === COMMAND_ACCEPTED_CODE) {
        resolveState(state, 'accepted')
        if (options.acceptedWithoutResult) {
          return { result: options.acceptedWithoutResult(), commandId, resent: true }
        }
        throw error
      }
      if (!isOutcomeUncertainError(error)) {
        resolveState(state, 'rejected')
        throw error
      }
      // Lost reply / timeout / token halt / outcome_unknown / in_progress: the
      // command may or may not have run — never `rejected`.
      const unknown = isOutcomeUnknown(error)
      state = setState({ ...state, phase: 'pending-reconcile', outcomeUnknown: unknown })
      if (unknown) markOutcomeUnknown(commandId)
      if (unknown || attempt >= delays.length) {
        warn(
          'command-engine',
          `${kind} ${commandId} is ${unknown ? 'outcome unknown' : 'still unconfirmed'} after ${state.attempts} send(s); kept pending-reconcile`
        )
        throw error
      }
      await sleep(delays[attempt])
    }
  }
}

// --- Detached commands (a prompt turn waiting to confirm) --------------------

export interface DetachedCommandHandlers<T> {
  /** Scope the command is deduped under (one per scope), e.g. a session id. */
  scope: string
  commandId: string
  kind: string
  entityKey: string
  /** Re-issue the SAME command (same id). */
  resend: () => Promise<T>
  /** The host answered the resend. */
  onResult: (result: T) => void
  /** The host definitely rejected the resend. */
  onDefiniteFailure: (error: unknown) => void
  /** True when the scope no longer exists (resends stop, the command is dropped). */
  isGone?: () => boolean
  /** True while a transport reconnect is in flight: a timer tick waits instead of racing it. */
  isBlocked?: () => boolean
  /** The first answer was already `outcome_unknown`: hold, do not auto-resend. */
  outcomeUnknown?: boolean
  /** Publishes the state (`null` once resolved) to whoever renders it. */
  onChange?: (state: CommandState | null) => void
}

interface DetachedCommand<T = unknown> extends DetachedCommandHandlers<T> {
  state: CommandState
  /** Timer-driven resends already spent: picks the backoff delay, not a limit. */
  attempts: number
  timer: ReturnType<typeof setTimeout> | undefined
  inFlight: boolean
  /** Abandoned (Stop): it must never be (re)dispatched again. */
  cancelled?: boolean
  /** Runs once a resend that was already in flight at abandon has settled. */
  afterCancelSettled?: () => void
}

const detached = new Map<string, DetachedCommand>()

function publish(cmd: DetachedCommand, state: CommandState | null): void {
  cmd.onChange?.(state)
}

function armTimer(cmd: DetachedCommand): void {
  clearTimeout(cmd.timer)
  cmd.timer = undefined
  const delay =
    COMMAND_RESEND_DELAYS_MS[Math.min(cmd.attempts, COMMAND_RESEND_DELAYS_MS.length - 1)]
  cmd.timer = setTimeout(() => {
    cmd.timer = undefined
    if (detached.get(cmd.scope) !== cmd) return
    // A reconnect in flight resends on its own completion — don't race it, but
    // keep the cadence alive in case that cycle ends without recovery.
    if (cmd.isBlocked?.()) {
      armTimer(cmd)
      return
    }
    cmd.attempts += 1
    runResend(cmd, false)
  }, delay)
}

/** A resend that outlived abandon has settled: let the caller cancel again. */
function settleCancelled(cmd: DetachedCommand): boolean {
  if (!cmd.cancelled) return false
  const after = cmd.afterCancelSettled
  cmd.afterCancelSettled = undefined
  after?.()
  return true
}

function runResend(cmd: DetachedCommand, manual: boolean): void {
  if (cmd.inFlight || cmd.cancelled) return
  // `outcome_unknown` is final for automatic resends — the host will not
  // answer differently; only a manual re-check asks again.
  if (cmd.state.outcomeUnknown && !manual) return
  if (cmd.isGone?.()) {
    dropDetached(cmd.scope, 'rejected')
    return
  }
  cmd.inFlight = true
  clearTimeout(cmd.timer)
  cmd.timer = undefined
  cmd.state = setState({
    ...cmd.state,
    phase: 'pending',
    attempts: cmd.state.attempts + 1,
    checking: manual
  })
  // Only a manual re-check is user-visible: show "Checking…" until it settles.
  if (manual) publish(cmd, cmd.state)
  let resending: Promise<unknown>
  try {
    resending = cmd.resend()
  } catch (error) {
    resending = Promise.reject(error)
  }
  void resending.then(
    (result) => {
      cmd.inFlight = false
      if (settleCancelled(cmd)) return
      if (detached.get(cmd.scope) !== cmd) return
      dropDetached(cmd.scope, 'accepted')
      cmd.onResult(result)
    },
    (error: unknown) => {
      cmd.inFlight = false
      if (settleCancelled(cmd)) return
      if (detached.get(cmd.scope) !== cmd) return
      // Dropped socket / timeout / token halt / outcome_unknown / in_progress:
      // the host never gave a final answer — keep waiting, never fail.
      if (isOutcomeUncertainError(error)) {
        const unknown = isOutcomeUnknown(error)
        cmd.state = setState({
          ...cmd.state,
          phase: 'pending-reconcile',
          outcomeUnknown: unknown,
          checking: false
        })
        if (unknown) markOutcomeUnknown(cmd.commandId)
        publish(cmd, cmd.state)
        if (!unknown) armTimer(cmd)
        return
      }
      dropDetached(cmd.scope, 'rejected')
      warn(
        'command-engine',
        `Resend of ${cmd.kind} ${cmd.commandId} on ${cmd.scope} was rejected: ${String(error)}`
      )
      cmd.onDefiniteFailure(error)
    }
  )
}

/**
 * Move a command whose caller moved on to pending-reconcile: keeps waiting and
 * resends the same id. One per scope — a previous one is replaced.
 */
export function beginDetachedCommand<T>(handlers: DetachedCommandHandlers<T>): CommandState {
  const previous = detached.get(handlers.scope)
  if (previous) {
    clearTimeout(previous.timer)
    previous.timer = undefined
    if (previous.commandId !== handlers.commandId) {
      // A different command takes the scope: the replaced one is over — it must
      // never resend again, and its state and journal entry resolve with it.
      previous.cancelled = true
      resolveState(previous.state, 'rejected')
    }
  }
  const existing = commandStates.get(handlers.commandId)
  const cmd: DetachedCommand<T> = {
    ...handlers,
    state: setState({
      commandId: handlers.commandId,
      kind: handlers.kind,
      entityKey: handlers.entityKey,
      phase: 'pending-reconcile',
      outcomeUnknown: handlers.outcomeUnknown === true,
      attempts: existing?.attempts ?? 1
    }),
    attempts: 0,
    timer: undefined,
    inFlight: false
  }
  detached.set(handlers.scope, cmd as DetachedCommand)
  if (cmd.state.outcomeUnknown) markOutcomeUnknown(cmd.commandId)
  publish(cmd as DetachedCommand, cmd.state)
  warn(
    'command-engine',
    `${handlers.kind} ${handlers.commandId} on ${handlers.scope} lost its reply; waiting to confirm and resending the same id`
  )
  if (!cmd.state.outcomeUnknown) armTimer(cmd as DetachedCommand)
  return cmd.state
}

/** Resolve (and forget) the detached command of `scope`. */
export function dropDetached(scope: string, phase: 'accepted' | 'rejected' = 'accepted'): void {
  const cmd = detached.get(scope)
  if (!cmd) return
  clearTimeout(cmd.timer)
  cmd.timer = undefined
  detached.delete(scope)
  resolveState(cmd.state, phase)
  publish(cmd, null)
}

/** The detached command of `scope`, if any. */
export function getDetachedState(scope: string): CommandState | undefined {
  return detached.get(scope)?.state
}

/** The detached command of `scope` only when it carries `commandId`. */
export function dropDetachedForCommand(scope: string, commandId: string): void {
  if (detached.get(scope)?.commandId === commandId) dropDetached(scope, 'accepted')
}

/**
 * Abandon the scope's detached command (Stop): no resend may dispatch it again
 * and its id resolves. A resend already in flight may still have started the
 * command on the host: `afterInFlightSettles` runs once it settles. Returns
 * the abandoned command's id, or `null` when there was none.
 */
export function abandonDetached(scope: string, afterInFlightSettles: () => void): string | null {
  const cmd = detached.get(scope)
  if (!cmd) return null
  cmd.cancelled = true
  if (cmd.inFlight) cmd.afterCancelSettled = afterInFlightSettles
  dropDetached(scope, 'rejected')
  return cmd.commandId
}

/**
 * Transport recovery (reconnect finished / snapshot installed): resend every
 * detached command now, or just `scope`'s. Deduped — a command with a resend
 * in flight is skipped, and so is one the host reported as outcome-unknown.
 */
export function resendDetached(scope?: string): void {
  const targets = scope ? [...detached].filter(([id]) => id === scope) : [...detached]
  for (const [, cmd] of targets) runResend(cmd, false)
}

/** Manual same-id re-check of the scope's command (the user asked to check). */
export function recheckDetached(scope: string): boolean {
  const cmd = detached.get(scope)
  if (!cmd) return false
  runResend(cmd, true)
  return true
}

/** Test-only: forget every command and cancel every timer. */
export function __resetCommandEngineForTesting(): void {
  for (const cmd of detached.values()) clearTimeout(cmd.timer)
  detached.clear()
  commandStates.clear()
  activeRuns.clear()
}

/** Test-only: number of detached commands. */
export function __detachedCommandCountForTesting(): number {
  return detached.size
}
