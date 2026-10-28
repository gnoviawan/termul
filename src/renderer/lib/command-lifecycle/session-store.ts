import type { SessionFrame, SessionRpcResult } from '@shared/types/command-session'
import type { TerminalModes } from '@shared/types/ipc.types'
import { logFrontendError } from '@/lib/log-api'
import { commandDraftStore } from './draft-store'
import { clearEditorRevision } from './editor-revision'
import { applyScreenMode, initialSessionState } from './screen-mode'
import {
  authenticated,
  type InputMode,
  reduceSession,
  type SessionPhase,
  type SessionState
} from './transition'

type PromptReadyFrame = Extract<SessionFrame, { type: 'PromptReady' }>

export interface SessionLifecycleInput {
  type?: string
  kind?: string
  session_id?: string
  sessionId?: string
  nonce?: string | null
  prompt_generation?: number | null
  line_empty?: boolean
  prompt_suppressed?: boolean
  cwd?: string | null
  exit_code?: number | null
  frame?: Partial<PromptReadyFrame>
}

export interface SubmitToken {
  sessionId: string
  nonce: string
  epoch: number
  committed?: boolean
}

export interface SessionSnapshot {
  sessionId: string | null
  nonce: string | null
  registered: boolean
  alive: boolean
  trusted: boolean
  mode: InputMode
  phase: SessionPhase
  promptGeneration: number | null
  lastExitCode: number | null
  committedSubmit: boolean
  completionPending: boolean
  alternateScreen: boolean
  cwd?: string
}

function snapshotFromInitial(): SessionSnapshot {
  const { buffer: _buffer, ...rest } = initialSessionState()
  return rest
}

const EMPTY_SNAPSHOT: SessionSnapshot = snapshotFromInitial()

function eventSessionId(event: SessionLifecycleInput): string | undefined {
  return event.session_id ?? event.sessionId
}

function toReducerState(snapshot: SessionSnapshot): SessionState {
  const { cwd: _cwd, ...rest } = snapshot
  return { ...rest, buffer: '' }
}

function fromReducerState(state: SessionState, cwd?: string): SessionSnapshot {
  const { buffer: _buffer, ...rest } = state
  return cwd === undefined ? rest : { ...rest, cwd }
}

function reducePromptEvent(
  sessionId: string,
  current: SessionSnapshot,
  event: SessionLifecycleInput
): SessionSnapshot {
  const frameNonce = event.nonce ?? event.frame?.nonce
  const generation = event.prompt_generation ?? event.frame?.prompt_generation
  const cwd = event.cwd ?? event.frame?.cwd
  if (typeof generation !== 'number' || typeof cwd !== 'string') return current
  const lineEmpty = event.line_empty ?? event.frame?.line_empty ?? false
  const promptSuppressed = event.prompt_suppressed ?? event.frame?.prompt_suppressed ?? false
  const base = toReducerState(current)
  const input =
    current.phase === 'Submitting' && current.trusted && current.mode === 'PTY'
      ? { ...base, committedSubmit: false }
      : base
  const reduced = reduceSession(input, {
    type: 'PromptReady',
    sessionId,
    frame: {
      type: 'PromptReady',
      nonce: frameNonce,
      prompt_generation: generation,
      line_empty: lineEmpty,
      prompt_suppressed: promptSuppressed,
      cwd
    }
  })
  return reduced.state === input ? current : fromReducerState(reduced.state, cwd)
}

function reduceStartedOrFinished(
  sessionId: string,
  current: SessionSnapshot,
  event: SessionLifecycleInput
): SessionSnapshot {
  const nonce = 'nonce' in event ? (event.nonce ?? undefined) : (current.nonce ?? undefined)
  const kind = event.type === 'session_lifecycle' ? event.kind : (event.type ?? event.kind)
  if (kind === 'CommandStarted') {
    // A host replay can announce execution started by another client. It must
    // demote the editor without treating this client's retained draft as submitted.
    // reduceSession keeps an authenticated CommandStarted at an Editor prompt as a
    // no-op, so the demotion stays here, gated by the reducer's own authenticated()
    // with the event's explicit nonce (never the snapshot fallback above).
    const replay = { type: 'CommandStarted', sessionId, nonce: event.nonce ?? undefined } as const
    if (
      current.mode === 'Editor' &&
      current.phase === 'AtPrompt' &&
      authenticated(toReducerState(current), replay)
    ) {
      return { ...current, mode: 'PTY', phase: 'Executing', completionPending: false }
    }
    const reduced = reduceSession(toReducerState(current), {
      type: 'CommandStarted',
      sessionId,
      nonce
    })
    return fromReducerState(reduced.state, current.cwd)
  }
  const reduced = reduceSession(toReducerState(current), {
    type: 'CommandFinished',
    sessionId,
    nonce,
    exit_code: event.exit_code ?? undefined
  })
  return fromReducerState(reduced.state, current.cwd)
}

function applyInitShell(current: SessionSnapshot, event: SessionLifecycleInput): SessionSnapshot {
  const changed = eventSessionId(event) !== current.sessionId || event.nonce !== current.nonce
  const base = current.mode === 'exited' || changed ? snapshotFromInitial() : current
  const sessionId = eventSessionId(event) ?? null
  return {
    ...base,
    sessionId,
    nonce: event.nonce ?? null,
    registered: sessionId !== null
  }
}

function matchesRegisteredSession(
  current: SessionSnapshot,
  event: SessionLifecycleInput
): string | null {
  const sessionId = eventSessionId(event)
  if (!current.registered || sessionId === undefined || sessionId !== current.sessionId) return null
  return sessionId
}

interface StoreContext {
  epoch: number
  submissions: Map<string, SubmitToken>
  sessions: Map<string, SessionSnapshot>
  listeners: Set<() => void>
}

function read(ctx: StoreContext, id: string): SessionSnapshot {
  return ctx.sessions.get(id) ?? EMPTY_SNAPSHOT
}

function notify(ctx: StoreContext): void {
  for (const listener of ctx.listeners) listener()
}

function write(ctx: StoreContext, id: string, next: SessionSnapshot): SessionSnapshot {
  const token = ctx.submissions.get(id)
  if (
    token &&
    (!next.alive ||
      !next.trusted ||
      next.mode === 'raw' ||
      next.sessionId !== token.sessionId ||
      next.nonce !== token.nonce)
  )
    ctx.submissions.delete(id)
  ctx.sessions.set(id, next)
  notify(ctx)
  return next
}

function commitSubmission(ctx: StoreContext, id: string, current: SessionSnapshot): void {
  const token = ctx.submissions.get(id)
  if (
    current.committedSubmit ||
    !token ||
    token.committed ||
    token.sessionId !== current.sessionId ||
    token.nonce !== current.nonce
  )
    return
  token.committed = true
  commandDraftStore.submitAccepted(id)
}

function logSubmit(message: string): void {
  void logFrontendError({ level: 'info', source: 'sessionStore', message })
}

function leaveEditor(ctx: StoreContext, id: string): void {
  const current = read(ctx, id)
  if (current.mode !== 'Editor' || current.phase !== 'AtPrompt') return
  write(ctx, id, { ...current, mode: 'PTY', completionPending: false })
  logSubmit('editor left: mode=PTY')
}

function beginSubmit(ctx: StoreContext, id: string): SubmitToken | null {
  const current = read(ctx, id)
  if (
    !current.registered ||
    !current.alive ||
    !current.trusted ||
    current.mode !== 'Editor' ||
    current.phase !== 'AtPrompt' ||
    !current.sessionId ||
    !current.nonce ||
    ctx.submissions.get(id)?.committed === false
  )
    return null
  const token: SubmitToken = {
    sessionId: current.sessionId,
    nonce: current.nonce,
    epoch: ++ctx.epoch,
    committed: false
  }
  ctx.submissions.set(id, token)
  write(ctx, id, { ...current, mode: 'PTY', phase: 'Submitting', completionPending: false })
  logSubmit('submit begun: phase=Submitting')
  return token
}

function recordSubmit(
  ctx: StoreContext,
  id: string,
  result: SessionRpcResult,
  token: SubmitToken
): boolean {
  const current = read(ctx, id)
  if (ctx.submissions.get(id) !== token) {
    logSubmit('submit reply ignored: stale transaction')
    return false
  }
  ctx.submissions.delete(id)
  logSubmit(`submit reply: result=${result}`)
  if (result === 'PreWrite' || result === 'NotStarted') {
    if (current.phase !== 'Submitting') return false
    write(ctx, id, { ...current, mode: 'Editor', phase: 'AtPrompt', committedSubmit: false })
    return true
  }
  if (result === 'Partial') {
    const reduced = reduceSession(toReducerState({ ...current, committedSubmit: false }), {
      type: 'Desync'
    })
    write(ctx, id, fromReducerState(reduced.state, current.cwd))
    return !token.committed
  }
  if (token.committed) return false
  token.committed = true
  write(ctx, id, { ...current, committedSubmit: result === 'Accepted' })
  return true
}

function processExited(ctx: StoreContext, id: string): SessionSnapshot {
  const current = read(ctx, id)
  const reduced = reduceSession(toReducerState(current), { type: 'ProcessExit' })
  clearEditorRevision(id)
  commandDraftStore.processExited(id)
  return write(ctx, id, fromReducerState(reduced.state, current.cwd))
}

function applyFallback(
  ctx: StoreContext,
  id: string,
  message: string,
  level: 'info' | 'warn',
  requireInitShell = false
): SessionSnapshot {
  const current = read(ctx, id)
  const reduced = reduceSession(toReducerState(current), { type: 'Desync' })
  const state = requireInitShell ? { ...reduced.state, registered: false } : reduced.state
  const next = write(ctx, id, fromReducerState(state, current.cwd))
  void logFrontendError({ level, source: 'sessionStore', message })
  return next
}

function applyDesync(ctx: StoreContext, id: string, event: SessionLifecycleInput): SessionSnapshot {
  const current = read(ctx, id)
  if (current.mode === 'raw' || event.nonce !== current.nonce) return current
  return applyFallback(ctx, id, 'session desync: mode=raw', 'info')
}

/** Local Desync fallback; registration must restart at a host InitShell. */
function invalidate(
  ctx: StoreContext,
  id: string,
  level: 'info' | 'warn' = 'warn'
): SessionSnapshot {
  return applyFallback(ctx, id, 'session history discarded: mode=raw', level, true)
}

function apply(ctx: StoreContext, id: string, event: SessionLifecycleInput): SessionSnapshot {
  const current = read(ctx, id)
  const kind = event.type === 'session_lifecycle' ? event.kind : (event.type ?? event.kind)
  if (kind === 'InitShell') return write(ctx, id, applyInitShell(current, event))
  const sessionId = matchesRegisteredSession(current, event)
  if (!sessionId) return current
  if (kind === 'Desync') return applyDesync(ctx, id, event)
  if (kind === 'PromptReady') {
    const next = reducePromptEvent(sessionId, current, event)
    if (
      (current.phase === 'Submitting' ||
        (current.phase === 'Executing' && current.committedSubmit)) &&
      next.mode === 'Editor' &&
      next.promptGeneration !== current.promptGeneration
    ) {
      commitSubmission(ctx, id, current)
      commandDraftStore.submitAccepted(id)
    }
    return write(ctx, id, next)
  }
  if (kind === 'CommandStarted' || kind === 'CommandFinished') {
    const next = reduceStartedOrFinished(sessionId, current, event)
    if (kind === 'CommandStarted' && current.phase === 'Submitting' && next.phase === 'Executing') {
      commitSubmission(ctx, id, current)
    }
    return write(ctx, id, next)
  }
  return current
}

function applyScreen(
  ctx: StoreContext,
  id: string,
  modes: TerminalModes | undefined
): SessionSnapshot {
  const current = read(ctx, id)
  const reduced = applyScreenMode(toReducerState(current), modes)
  if (
    reduced.state.mode === current.mode &&
    reduced.state.alternateScreen === current.alternateScreen
  )
    return current
  return write(ctx, id, fromReducerState(reduced.state, current.cwd))
}

export function createSessionStore() {
  const ctx: StoreContext = {
    epoch: 0,
    submissions: new Map(),
    sessions: new Map(),
    listeners: new Set()
  }
  return {
    read: (id: string) => read(ctx, id),
    get: (id: string) => read(ctx, id),
    subscribe(listener: () => void): () => void {
      ctx.listeners.add(listener)
      return () => {
        ctx.listeners.delete(listener)
      }
    },
    leaveEditor: (id: string) => leaveEditor(ctx, id),
    beginSubmit: (id: string) => beginSubmit(ctx, id),
    isSubmitCurrent: (id: string, token: SubmitToken) =>
      ctx.submissions.get(id) === token && !token.committed,
    recordSubmit: (id: string, result: SessionRpcResult, token: SubmitToken) =>
      recordSubmit(ctx, id, result, token),
    processExited: (id: string) => processExited(ctx, id),
    invalidate: (id: string, level: 'info' | 'warn' = 'warn') => invalidate(ctx, id, level),
    apply: (id: string, event: SessionLifecycleInput) => apply(ctx, id, event),
    applyScreen: (id: string, modes: TerminalModes | undefined) => applyScreen(ctx, id, modes),
    reset(): void {
      ctx.submissions.clear()
      ctx.sessions.clear()
      notify(ctx)
    }
  }
}

export const sessionStore = createSessionStore()
