import type { SessionFrame } from '@shared/types/command-session'

/** Input surface. Editor is mounted only for a trusted suppressed prompt. */
export type InputMode = 'Editor' | 'PTY' | 'raw' | 'exited'

/** Shell phase. CompletionPending is not a phase; it stays inside AtPrompt. */
export type SessionPhase = 'Unknown' | 'AtPrompt' | 'Submitting' | 'Executing' | 'Terminated'

/** Session identity, shell lifecycle, and the retained editor draft. */
export interface SessionState {
  sessionId: string | null
  nonce: string | null
  registered: boolean
  alive: boolean
  trusted: boolean
  mode: InputMode
  phase: SessionPhase
  buffer: string
  promptGeneration: number | null
  lastExitCode: number | null
  committedSubmit: boolean
  completionPending: boolean
  alternateScreen: boolean
}

/** Safe metadata describing a session fallback. */
export interface SessionLogEvent {
  name: string
  detail: string
}

/** Next state and host-facing effects of one session event. */
export interface SessionReduction {
  state: SessionState
  /** True only when the host must write the draft. Fallback must leave this false. */
  writeDraft: boolean
  log: SessionLogEvent | null
}

type PromptReadyFrame = Extract<SessionFrame, { type: 'PromptReady' }>

/** Shell lifecycle and local terminal signals accepted by the reducer. */
export type SessionEvent =
  | { type: 'PromptReady'; sessionId?: string; frame: PromptReadyFrame }
  | { type: 'CommandStarted'; sessionId?: string; nonce?: string }
  | { type: 'CommandFinished'; sessionId?: string; nonce?: string; exit_code?: number }
  | { type: 'Osc133'; text: string }
  | { type: 'IntegrationLost' }
  | { type: 'ProcessExit' }
  | { type: 'CompletionPending' }
  | { type: 'Desync' }
  | { type: 'AlternateScreenEnter' }
  | { type: 'AlternateScreenLeave' }
  | { type: 'Elapsed'; ms: number }

export type LifecycleEvent = Extract<
  SessionEvent,
  { type: 'PromptReady' | 'CommandStarted' | 'CommandFinished' }
>

function hold(state: SessionState): SessionReduction {
  return { state, writeDraft: false, log: null }
}

function isSubmittingTransaction(state: SessionState): boolean {
  return state.phase === 'Submitting' && state.trusted && state.mode === 'PTY'
}

function fallbackRaw(state: SessionState, detail: string): SessionReduction {
  return {
    state: {
      ...state,
      mode: 'raw',
      phase: 'Unknown',
      trusted: false,
      completionPending: false
    },
    writeDraft: false,
    log: { name: 'fallback', detail }
  }
}

function canMountEditor(state: SessionState, frame: PromptReadyFrame, generation: number): boolean {
  return (
    frame.prompt_suppressed === true &&
    frame.line_empty === true &&
    !state.alternateScreen &&
    (state.promptGeneration === null || generation > state.promptGeneration) &&
    !(state.committedSubmit && state.phase !== 'Executing') &&
    !(state.mode === 'Editor' && !state.committedSubmit)
  )
}

function openEditor(state: SessionState, generation: number): SessionReduction {
  return hold({
    ...state,
    mode: 'Editor',
    phase: 'AtPrompt',
    trusted: true,
    buffer: state.committedSubmit || isSubmittingTransaction(state) ? '' : state.buffer,
    committedSubmit: false,
    completionPending: false,
    promptGeneration: generation
  })
}

function isLifecycleEvent(event: SessionEvent): event is LifecycleEvent {
  return (
    event.type === 'PromptReady' ||
    event.type === 'CommandStarted' ||
    event.type === 'CommandFinished'
  )
}

/** Live registered session, matching session id, and an explicit matching nonce. */
export function authenticated(state: SessionState, event: LifecycleEvent): boolean {
  const nonce = event.type === 'PromptReady' ? event.frame.nonce : event.nonce
  return (
    state.alive &&
    state.registered &&
    event.sessionId !== undefined &&
    event.sessionId === state.sessionId &&
    nonce !== undefined &&
    nonce === state.nonce
  )
}

function reducePrompt(state: SessionState, frame: PromptReadyFrame): SessionReduction {
  const generation = frame.prompt_generation
  if (typeof generation === 'number' && canMountEditor(state, frame, generation)) {
    return openEditor(state, generation)
  }
  if (
    isSubmittingTransaction(state) &&
    typeof generation === 'number' &&
    (state.promptGeneration === null || generation > state.promptGeneration) &&
    (!frame.prompt_suppressed || !frame.line_empty)
  ) {
    return fallbackRaw(state, 'mode=raw reason=unsuppressed_prompt')
  }
  return hold(state)
}

function reduceLifecycle(state: SessionState, event: LifecycleEvent): SessionReduction {
  if (!authenticated(state, event)) return hold(state)
  if (event.type === 'PromptReady') return reducePrompt(state, event.frame)
  if (event.type === 'CommandStarted') {
    return hold(
      state.committedSubmit || isSubmittingTransaction(state)
        ? {
            ...state,
            mode: 'PTY',
            phase: 'Executing',
            committedSubmit: true,
            completionPending: false
          }
        : state
    )
  }
  if (state.mode === 'Editor' && !state.committedSubmit) return hold(state)
  return hold({
    ...state,
    phase: state.committedSubmit ? 'Executing' : state.phase,
    completionPending: state.committedSubmit ? false : state.completionPending,
    lastExitCode: event.exit_code ?? state.lastExitCode
  })
}

function reduceExitOrFallback(state: SessionState, event: SessionEvent): SessionReduction | null {
  if (event.type === 'ProcessExit') {
    return hold({
      ...state,
      mode: 'exited',
      buffer: '',
      alive: false,
      phase: 'Terminated',
      trusted: false,
      completionPending: false
    })
  }
  if (event.type === 'Desync' || event.type === 'IntegrationLost') {
    return fallbackRaw(
      state,
      `mode=raw reason=${event.type === 'Desync' ? 'desync' : 'integration_lost'}`
    )
  }
  return null
}

/** Pure session reducer. Only an authenticated suppressed prompt mounts the editor. */
export function reduceSession(state: SessionState, event: SessionEvent): SessionReduction {
  if (!state.alive || state.mode === 'exited') return hold(state)
  if (isLifecycleEvent(event)) return reduceLifecycle(state, event)
  const exitOrFallback = reduceExitOrFallback(state, event)
  if (exitOrFallback) return exitOrFallback
  switch (event.type) {
    case 'AlternateScreenEnter':
      return hold({ ...state, alternateScreen: true, mode: 'PTY', completionPending: false })
    case 'AlternateScreenLeave':
      return hold({ ...state, alternateScreen: false })
    case 'CompletionPending':
      if (
        !state.trusted ||
        state.mode !== 'Editor' ||
        state.phase !== 'AtPrompt' ||
        state.committedSubmit ||
        state.alternateScreen
      )
        return hold(state)
      return hold({ ...state, completionPending: true })
    default:
      return hold(state)
  }
}
