import type { TerminalModes } from '@shared/types/ipc.types'
import { describe, expect, it } from 'vitest'
import { applyScreenMode } from './screen-mode'
import type { SessionState } from './transition'

const modes: TerminalModes = {
  alternateScreen: true,
  bracketedPaste: false,
  applicationCursor: false,
  mouseTracking: null,
  sgrMouseMode: false,
  sgrMousePixelsMode: false
}

function editorSession(): SessionState {
  return {
    sessionId: 'session-a',
    nonce: 'test-nonce',
    registered: true,
    alive: true,
    trusted: true,
    mode: 'Editor',
    phase: 'AtPrompt',
    buffer: 'draft',
    promptGeneration: 1,
    lastExitCode: null,
    committedSubmit: false,
    completionPending: true,
    alternateScreen: false
  }
}

describe('applyScreenMode', () => {
  it('alternate screen comes from the mode tracker', () => {
    const state = editorSession()
    const next = applyScreenMode(state, modes)
    expect(next.state.mode).toBe('PTY')
    expect(next.state.alternateScreen).toBe(true)
    expect(next.state.completionPending).toBe(false)
    expect(next.state.buffer).toBe('draft')
    expect(next.writeDraft).toBe(false)
    expect(next.log).toBeNull()
    expect(state.mode).toBe('Editor')
    expect(applyScreenMode(next.state, modes).state).toBe(next.state)
    expect(applyScreenMode(state, undefined).state).toBe(state)
  })
  it('leaving the alternate screen does not open the editor', () => {
    const entered = applyScreenMode(editorSession(), modes).state
    const next = applyScreenMode(entered, { ...modes, alternateScreen: false })
    expect(next.state.mode).toBe('PTY')
    expect(next.state.alternateScreen).toBe(false)
    expect(next.state.buffer).toBe('draft')
    expect(next.writeDraft).toBe(false)
    expect(next.log).toBeNull()
    expect(applyScreenMode(next.state, { ...modes, alternateScreen: false }).state).toBe(next.state)
  })
})
