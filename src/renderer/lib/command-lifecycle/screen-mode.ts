import type { TerminalModes } from '@shared/types/ipc.types'
import { reduceSession, type SessionReduction, type SessionState } from './transition'

export function initialSessionState(): SessionState {
  return {
    sessionId: null,
    nonce: null,
    registered: false,
    alive: true,
    trusted: false,
    mode: 'PTY',
    phase: 'Unknown',
    buffer: '',
    promptGeneration: null,
    lastExitCode: null,
    committedSubmit: false,
    completionPending: false,
    alternateScreen: false
  }
}

export function applyScreenMode(
  state: SessionState,
  modes: TerminalModes | undefined
): SessionReduction {
  if (modes?.alternateScreen && !state.alternateScreen) {
    return reduceSession(state, { type: 'AlternateScreenEnter' })
  }
  if (modes && !modes.alternateScreen && state.alternateScreen) {
    return reduceSession(state, { type: 'AlternateScreenLeave' })
  }
  return { state, writeDraft: false, log: null }
}
