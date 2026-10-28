import { describe, expect, it } from 'vitest'

import { reduceSession, type SessionEvent, type SessionState } from './transition'

const SESSION_ID = 's1'
const NONCE = 'n1'

function registeredSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: SESSION_ID,
    nonce: NONCE,
    registered: true,
    alive: true,
    trusted: true,
    mode: 'raw',
    phase: 'Unknown',
    buffer: '',
    lastExitCode: null,
    promptGeneration: null,
    committedSubmit: false,
    completionPending: false,
    alternateScreen: false,
    ...overrides
  }
}

function promptEvent(generation = 1): Extract<SessionEvent, { type: 'PromptReady' }> {
  return {
    type: 'PromptReady',
    sessionId: SESSION_ID,
    frame: {
      type: 'PromptReady',
      nonce: NONCE,
      prompt_generation: generation,
      line_empty: true,
      prompt_suppressed: true,
      cwd: '/repo'
    }
  }
}

function expectIgnored(state: SessionState, event: SessionEvent): void {
  const result = reduceSession(state, event)
  expect(result.state).toEqual(state)
  expect(result.writeDraft).toBe(false)
  expect(result.log).toBeNull()
}

describe('reduceSession', () => {
  it('executing does not time out into the editor', () => {
    const state = registeredSession({
      mode: 'PTY',
      phase: 'Executing',
      buffer: 'git status',
      committedSubmit: true
    })

    for (const ms of [0, 50, 1_000, 60_000, Number.MAX_SAFE_INTEGER]) {
      const result = reduceSession(state, { type: 'Elapsed', ms })

      expect(result.state.mode).toBe('PTY')
      expect(result.state.phase).toBe('Executing')
      expect(result.state.buffer).toBe('git status')
      expect(result.writeDraft).toBe(false)
      expect(result.log).toBeNull()
    }
  })

  it('unregistered session does not change state', () => {
    const result = reduceSession(
      registeredSession({
        mode: 'PTY',
        phase: 'Executing',
        buffer: 'git status',
        committedSubmit: true
      }),
      {
        type: 'PromptReady',
        sessionId: 'unregistered-session',
        frame: {
          type: 'PromptReady',
          nonce: NONCE,
          prompt_generation: 1,
          line_empty: true,
          prompt_suppressed: true,
          cwd: '/repo'
        }
      }
    )

    expect(result.state.mode).toBe('PTY')
    expect(result.state.buffer).toBe('git status')
    expect(result.writeDraft).toBe(false)
    expect(result.log).toBeNull()
  })

  it('leaving the alternate screen waits for a prompt', () => {
    const entered = reduceSession(
      registeredSession({ mode: 'Editor', phase: 'AtPrompt', buffer: 'git status' }),
      { type: 'AlternateScreenEnter' }
    )

    const result = reduceSession(entered.state, { type: 'AlternateScreenLeave' })

    expect(result.state.mode).toBe('PTY')
    expect(result.state.buffer).toBe('git status')
    expect(result.writeDraft).toBe(false)
    expect(result.log).toBeNull()
  })

  it('alternate screen enters the PTY', () => {
    const result = reduceSession(registeredSession({ mode: 'Editor', phase: 'AtPrompt' }), {
      type: 'AlternateScreenEnter'
    })

    expect(result.state.mode).toBe('PTY')
  })

  it('next editor after a submit is empty', () => {
    const result = reduceSession(
      registeredSession({
        mode: 'PTY',
        phase: 'Executing',
        buffer: 'git status',
        committedSubmit: true
      }),
      {
        type: 'PromptReady',
        sessionId: SESSION_ID,
        frame: {
          type: 'PromptReady',
          nonce: NONCE,
          prompt_generation: 2,
          line_empty: true,
          prompt_suppressed: true,
          cwd: '/repo'
        }
      }
    )

    expect(result.state.mode).toBe('Editor')
    expect(result.state.buffer).toBe('')
  })

  it('committed submit leaves the editor', () => {
    const result = reduceSession(
      registeredSession({ mode: 'Editor', phase: 'AtPrompt', committedSubmit: true }),
      { type: 'CommandStarted', sessionId: SESSION_ID, nonce: NONCE }
    )

    expect(result.state.mode).not.toBe('Editor')
  })

  it('command started without a submit is ignored', () => {
    const result = reduceSession(
      registeredSession({
        mode: 'Editor',
        phase: 'AtPrompt',
        buffer: 'git status',
        committedSubmit: false
      }),
      { type: 'CommandStarted', sessionId: SESSION_ID, nonce: NONCE }
    )

    expect(result.state.mode).toBe('Editor')
    expect(result.state.buffer).toBe('git status')
    expect(result.state.phase).toBe('AtPrompt')
    expect(result.writeDraft).toBe(false)
    expect(result.log).toBeNull()
  })

  it('nested prompt stays in submitting', () => {
    const result = reduceSession(
      registeredSession({ mode: 'PTY', phase: 'Submitting', committedSubmit: true }),
      {
        type: 'PromptReady',
        sessionId: SESSION_ID,
        frame: {
          type: 'PromptReady',
          nonce: NONCE,
          prompt_generation: 1,
          line_empty: true,
          prompt_suppressed: true,
          cwd: '/repo'
        }
      }
    )

    expect(result.state.mode).toBe('PTY')
    expect(result.state.phase).toBe('Submitting')
    expect(result.writeDraft).toBe(false)
    expect(result.log).toBeNull()
  })

  it('duplicate exit code does not clear', () => {
    const result = reduceSession(
      registeredSession({ mode: 'PTY', phase: 'Executing', lastExitCode: 2 }),
      {
        type: 'CommandFinished',
        sessionId: SESSION_ID,
        nonce: NONCE,
        exit_code: 2
      }
    )

    expect(result.state.lastExitCode).toBe(2)
  })

  it('missing exit code keeps the previous code', () => {
    const result = reduceSession(
      registeredSession({ mode: 'PTY', phase: 'Executing', lastExitCode: 2 }),
      {
        type: 'CommandFinished',
        sessionId: SESSION_ID,
        nonce: NONCE
      }
    )

    expect(result.state.lastExitCode).toBe(2)
  })

  it('an exit code is recorded', () => {
    const result = reduceSession(
      registeredSession({ mode: 'PTY', phase: 'Executing', lastExitCode: 0 }),
      {
        type: 'CommandFinished',
        sessionId: SESSION_ID,
        nonce: NONCE,
        exit_code: 2
      }
    )

    expect(result.state.lastExitCode).toBe(2)
    expect(result.state.mode).toBe('PTY')
  })

  it('command finished does not open the editor', () => {
    for (const phase of ['Submitting', 'Executing'] as const) {
      const result = reduceSession(registeredSession({ mode: 'PTY', phase }), {
        type: 'CommandFinished',
        sessionId: SESSION_ID,
        nonce: NONCE,
        exit_code: 0
      })

      expect(result.state.mode).toBe('PTY')
      expect(result.writeDraft).toBe(false)
      expect(result.log).toBeNull()
    }
  })

  it('trusted prompt opens the editor', () => {
    const result = reduceSession(registeredSession(), {
      type: 'PromptReady',
      sessionId: SESSION_ID,
      frame: {
        type: 'PromptReady',
        nonce: NONCE,
        prompt_generation: 1,
        line_empty: true,
        prompt_suppressed: true,
        cwd: '/repo'
      }
    })

    expect(result.state.mode).toBe('Editor')
    expect(result.state.buffer).toBe('')
  })

  it('later trusted prompt restores the unsent draft', () => {
    const fallback = reduceSession(
      registeredSession({ mode: 'Editor', phase: 'AtPrompt', buffer: 'make test' }),
      { type: 'IntegrationLost' }
    )

    const result = reduceSession(fallback.state, {
      type: 'PromptReady',
      sessionId: SESSION_ID,
      frame: {
        type: 'PromptReady',
        nonce: NONCE,
        prompt_generation: 2,
        line_empty: true,
        prompt_suppressed: true,
        cwd: '/repo'
      }
    })

    expect(result.state.mode).toBe('Editor')
    expect(result.state.buffer).toBe('make test')
  })

  it('ambient OSC stays raw', () => {
    const result = reduceSession(
      registeredSession({ registered: false, trusted: false, nonce: null, sessionId: null }),
      { type: 'Osc133', text: '\u001b]133;A\u0007' }
    )

    expect(result.state.mode).toBe('raw')
  })

  it('missing nonce stays raw', () => {
    const result = reduceSession(registeredSession(), {
      type: 'PromptReady',
      sessionId: SESSION_ID,
      frame: {
        type: 'PromptReady',
        prompt_generation: 1,
        line_empty: true,
        prompt_suppressed: true,
        cwd: '/repo'
      }
    })

    expect(result.state.mode).toBe('raw')
  })

  it('unsuppressed newer prompt ends submitting and stays raw', () => {
    const result = reduceSession(
      registeredSession({
        mode: 'PTY',
        phase: 'Submitting',
        trusted: true,
        promptGeneration: 1,
        committedSubmit: true
      }),
      {
        type: 'PromptReady',
        sessionId: SESSION_ID,
        frame: {
          type: 'PromptReady',
          nonce: NONCE,
          prompt_generation: 2,
          line_empty: true,
          prompt_suppressed: false,
          cwd: '/repo'
        }
      }
    )

    expect(result.state.mode).toBe('raw')
    expect(result.state.phase).not.toBe('Submitting')
    expect(result.state.trusted).toBe(false)
    expect(result.state.mode).not.toBe('Editor')
  })

  it('visible prompt stays raw', () => {
    const result = reduceSession(registeredSession(), {
      type: 'PromptReady',
      sessionId: SESSION_ID,
      frame: {
        type: 'PromptReady',
        nonce: NONCE,
        prompt_generation: 1,
        line_empty: true,
        prompt_suppressed: false,
        cwd: '/repo'
      }
    })

    expect(result.state.mode).toBe('raw')
  })

  it('process exit drops the draft', () => {
    const result = reduceSession(
      registeredSession({ mode: 'Editor', phase: 'AtPrompt', buffer: 'git status' }),
      { type: 'ProcessExit' }
    )

    expect(result.state.buffer).toBe('')
    expect(result.state.mode).toBe('exited')
  })

  it('duplicate prompt keeps the draft', () => {
    const result = reduceSession(
      registeredSession({ mode: 'Editor', phase: 'AtPrompt', buffer: 'git status' }),
      {
        type: 'PromptReady',
        sessionId: SESSION_ID,
        frame: {
          type: 'PromptReady',
          nonce: NONCE,
          prompt_generation: 1,
          line_empty: true,
          prompt_suppressed: true,
          cwd: '/repo'
        }
      }
    )

    expect(result.state.buffer).toBe('git status')
    expect(result.state.mode).toBe('Editor')
  })

  it('completion pending stays at the prompt', () => {
    const result = reduceSession(registeredSession({ mode: 'Editor', phase: 'AtPrompt' }), {
      type: 'CompletionPending'
    })

    expect(result.state.phase).toBe('AtPrompt')
    expect(result.state.mode).toBe('Editor')
    expect(result.state.completionPending).toBe(true)
    expect(result.writeDraft).toBe(false)
  })

  it('desync falls back to raw', () => {
    const result = reduceSession(
      registeredSession({ mode: 'Editor', phase: 'AtPrompt', buffer: 'git status' }),
      { type: 'Desync' }
    )

    expect(result.state.mode).toBe('raw')
    expect(result.writeDraft).toBe(false)
    expect(result.state.buffer).toBe('git status')
    expect(JSON.stringify(result.log)).not.toContain('git status')
  })

  it('lost integration does not execute the draft', () => {
    const result = reduceSession(
      registeredSession({ mode: 'Editor', phase: 'AtPrompt', buffer: 'git status' }),
      { type: 'IntegrationLost' }
    )

    expect(result.writeDraft).toBe(false)
    expect(result.state.mode).toBe('raw')
    expect(result.state.alive).toBe(true)
    expect(result.state.buffer).toBe('git status')
    expect(result.log?.name ?? '').toMatch(/fallback/)
    expect(JSON.stringify(result.log)).not.toContain('git status')
  })

  it('ignored events never mark the draft for writing', () => {
    const prompt = promptEvent()
    const events: SessionEvent[] = [
      { type: 'Osc133', text: '\u001b]133;A\u0007' },
      { ...prompt, frame: { ...prompt.frame, nonce: 'wrong' } },
      { ...prompt, frame: { ...prompt.frame, nonce: undefined } },
      { ...prompt, frame: { ...prompt.frame, prompt_suppressed: false } },
      { ...prompt, frame: { ...prompt.frame, line_empty: false } },
      { type: 'CommandStarted', sessionId: SESSION_ID, nonce: NONCE }
    ]
    for (const mode of ['PTY', 'raw'] as const) {
      const state = registeredSession({ mode, buffer: 'draft' })
      for (const event of events) expectIgnored(state, event)
    }
  })

  it('restoring a draft does not mark it for writing', () => {
    const fallback = reduceSession(
      registeredSession({ mode: 'Editor', phase: 'AtPrompt', buffer: 'make test' }),
      { type: 'IntegrationLost' }
    )
    const result = reduceSession(fallback.state, promptEvent(2))
    expect(result.state.mode).toBe('Editor')
    expect(result.state.buffer).toBe('make test')
    expect(result.state.trusted).toBe(true)
    expect(result.writeDraft).toBe(false)
  })

  it('a new draft survives a duplicate prompt after a submit', () => {
    const prompt = promptEvent(2)
    const opened = reduceSession(
      registeredSession({
        mode: 'PTY',
        phase: 'Executing',
        committedSubmit: true,
        buffer: 'git status'
      }),
      prompt
    )
    expect(opened.state.mode).toBe('Editor')
    expect(opened.state.buffer).toBe('')
    expect(opened.state.committedSubmit).toBe(false)
    const draft = { ...opened.state, buffer: 'ls' }
    const duplicate = reduceSession(draft, prompt)
    expect(duplicate.state.mode).toBe('Editor')
    expect(duplicate.state.buffer).toBe('ls')
    expectIgnored(draft, prompt)
    expectIgnored(duplicate.state, {
      type: 'CommandStarted',
      sessionId: SESSION_ID,
      nonce: NONCE
    })
  })

  it("lifecycle events without this session's identity change nothing", () => {
    const events: SessionEvent[] = [
      promptEvent(),
      { type: 'CommandStarted', sessionId: SESSION_ID, nonce: NONCE },
      { type: 'CommandFinished', sessionId: SESSION_ID, nonce: NONCE, exit_code: 9 }
    ]
    for (const event of events) {
      const state = registeredSession({
        mode: 'Editor',
        phase: 'Executing',
        committedSubmit: true,
        buffer: 'draft'
      })
      const withoutSessionId = { ...event }
      delete withoutSessionId.sessionId
      expectIgnored(state, withoutSessionId)
      expectIgnored(state, { ...event, sessionId: undefined })
      expectIgnored(state, { ...event, sessionId: 'other' })
      for (const nonce of [undefined, 'wrong']) {
        const invalid =
          event.type === 'PromptReady'
            ? { ...event, frame: { ...event.frame, nonce } }
            : { ...event, nonce }
        expectIgnored(state, invalid)
      }
      const withoutNonce =
        event.type === 'PromptReady' ? { ...event, frame: { ...event.frame } } : { ...event }
      if (withoutNonce.type === 'PromptReady') delete withoutNonce.frame.nonce
      else delete withoutNonce.nonce
      expectIgnored(state, withoutNonce)
      expectIgnored({ ...state, registered: false }, event)
    }
  })

  it('a full submission returns to an empty editor', () => {
    const state = registeredSession({
      mode: 'PTY',
      phase: 'Submitting',
      committedSubmit: true,
      buffer: 'git status',
      promptGeneration: 1
    })
    expectIgnored(state, promptEvent(2))
    const intermediate = reduceSession(state, promptEvent(2))
    const started = reduceSession(intermediate.state, {
      type: 'CommandStarted',
      sessionId: SESSION_ID,
      nonce: NONCE
    })
    expect(started.state.mode).toBe('PTY')
    expect(started.state.phase).toBe('Executing')
    expect(started.writeDraft).toBe(false)
    const finished = reduceSession(started.state, {
      type: 'CommandFinished',
      sessionId: SESSION_ID,
      nonce: NONCE,
      exit_code: 3
    })
    expect(finished.state.lastExitCode).toBe(3)
    expect(finished.state.mode).toBe('PTY')
    expect(finished.writeDraft).toBe(false)
    const result = reduceSession(finished.state, promptEvent(3))
    expect(result.state.mode).toBe('Editor')
    expect(result.state.phase).toBe('AtPrompt')
    expect(result.state.buffer).toBe('')
    expect(result.state.committedSubmit).toBe(false)
    expect(result.state.promptGeneration).toBe(3)
    expect(result.writeDraft).toBe(false)
  })

  it('command started executes a committed or trusted submitting transaction', () => {
    const event: SessionEvent = { type: 'CommandStarted', sessionId: SESSION_ID, nonce: NONCE }
    for (const mode of ['Editor', 'PTY', 'raw'] as const) {
      for (const phase of [
        'Unknown',
        'AtPrompt',
        'Submitting',
        'Executing',
        'Terminated'
      ] as const) {
        const state = registeredSession({ mode, phase, buffer: 'draft' })
        if (mode === 'PTY' && phase === 'Submitting') {
          expect(reduceSession(state, event).state).toMatchObject({
            mode: 'PTY',
            phase: 'Executing',
            committedSubmit: true
          })
        } else {
          expectIgnored(state, event)
        }
        const result = reduceSession({ ...state, committedSubmit: true }, event)
        expect(result.state.mode).toBe('PTY')
        expect(result.state.phase).toBe('Executing')
        expect(result.state.buffer).toBe('draft')
        expect(result.writeDraft).toBe(false)
      }
    }
    expectIgnored(
      registeredSession({
        mode: 'exited',
        alive: false,
        phase: 'Terminated',
        committedSubmit: true
      }),
      event
    )
  })

  it('a committed submit ignores prompts until executing', () => {
    for (const mode of ['Editor', 'PTY'] as const) {
      for (const phase of ['AtPrompt', 'Submitting'] as const) {
        expectIgnored(registeredSession({ mode, phase, committedSubmit: true }), promptEvent())
      }
    }
  })

  it('a replayed old prompt does not open the editor', () => {
    const state = registeredSession({
      mode: 'PTY',
      phase: 'Executing',
      committedSubmit: true,
      promptGeneration: 4
    })
    expectIgnored(state, promptEvent(3))
    expectIgnored(state, promptEvent(4))
    const result = reduceSession(state, promptEvent(5))
    expect(result.state.mode).toBe('Editor')
    expect(result.state.promptGeneration).toBe(5)
    expect(result.writeDraft).toBe(false)
  })

  it('a prompt inside the alternate screen keeps the PTY', () => {
    const entered = reduceSession(registeredSession({ mode: 'Editor', phase: 'AtPrompt' }), {
      type: 'AlternateScreenEnter'
    })
    expect(entered.state.alternateScreen).toBe(true)
    expect(entered.state.mode).toBe('PTY')
    expectIgnored(entered.state, promptEvent(2))
    const prompt = reduceSession(entered.state, promptEvent(2))
    const left = reduceSession(prompt.state, { type: 'AlternateScreenLeave' })
    expect(left.state.alternateScreen).toBe(false)
    expect(left.state.mode).toBe('PTY')
    const result = reduceSession(left.state, promptEvent(3))
    expect(result.state.mode).toBe('Editor')
    expect(result.writeDraft).toBe(false)
  })

  it('a prompt after process exit stays exited', () => {
    const exited = reduceSession(
      registeredSession({
        mode: 'Editor',
        phase: 'AtPrompt',
        buffer: 'draft',
        committedSubmit: true
      }),
      { type: 'ProcessExit' }
    )
    expect(exited.state.mode).toBe('exited')
    expect(exited.state.buffer).toBe('')
    expect(exited.state.alive).toBe(false)
    expect(exited.state.phase).toBe('Terminated')
    expect(exited.state.trusted).toBe(false)
    expect(exited.writeDraft).toBe(false)
    expectIgnored(exited.state, promptEvent())
    expectIgnored(exited.state, { type: 'CommandStarted', sessionId: SESSION_ID, nonce: NONCE })
    expectIgnored(exited.state, {
      type: 'CommandFinished',
      sessionId: SESSION_ID,
      nonce: NONCE,
      exit_code: 9
    })
  })

  it('a trusted prompt after desync restores the draft', () => {
    const fallback = reduceSession(
      registeredSession({
        mode: 'Editor',
        phase: 'AtPrompt',
        buffer: 'make test'
      }),
      { type: 'Desync' }
    )
    expect(fallback.state.trusted).toBe(false)
    const result = reduceSession(fallback.state, promptEvent(2))
    expect(result.state.mode).toBe('Editor')
    expect(result.state.buffer).toBe('make test')
    expect(result.state.trusted).toBe(true)
    expect(result.writeDraft).toBe(false)
  })

  it('command finished in an unsubmitted editor is ignored', () => {
    expectIgnored(
      registeredSession({
        mode: 'Editor',
        phase: 'AtPrompt',
        buffer: 'x',
        lastExitCode: 1
      }),
      { type: 'CommandFinished', sessionId: SESSION_ID, nonce: NONCE, exit_code: 9 }
    )
  })

  it('a prompt without a generation is ignored', () => {
    const event = promptEvent()
    delete event.frame.prompt_generation
    expectIgnored(registeredSession({ buffer: 'draft' }), event)
  })

  it('generation zero opens once', () => {
    const opened = reduceSession(registeredSession({ buffer: 'draft' }), promptEvent(0))
    expect(opened.state.mode).toBe('Editor')
    expect(opened.state.promptGeneration).toBe(0)
    expect(opened.state.buffer).toBe('draft')
    expect(opened.writeDraft).toBe(false)
    expectIgnored(opened.state, promptEvent(0))
    const fallback = reduceSession(opened.state, { type: 'Desync' })
    expectIgnored(fallback.state, promptEvent(0))
    const next = reduceSession(fallback.state, promptEvent(1))
    expect(next.state.mode).toBe('Editor')
    expect(next.state.promptGeneration).toBe(1)
    expect(next.state.buffer).toBe('draft')
    expect(next.writeDraft).toBe(false)
  })

  it('an exited session ignores every later event', () => {
    const exited = reduceSession(
      registeredSession({ mode: 'Editor', phase: 'AtPrompt', buffer: 'draft' }),
      { type: 'ProcessExit' }
    )
    expect(exited.state.mode).toBe('exited')
    expect(exited.state.buffer).toBe('')
    expect(exited.state.alive).toBe(false)
    expect(exited.state.phase).toBe('Terminated')
    expect(exited.state.trusted).toBe(false)
    expect(exited.writeDraft).toBe(false)
    expect(exited.log).toBeNull()
    const events: SessionEvent[] = [
      promptEvent(2),
      { type: 'CommandStarted', sessionId: SESSION_ID, nonce: NONCE },
      { type: 'CommandFinished', sessionId: SESSION_ID, nonce: NONCE, exit_code: 0 },
      { type: 'Desync' },
      { type: 'IntegrationLost' },
      { type: 'AlternateScreenEnter' },
      { type: 'AlternateScreenLeave' },
      { type: 'CompletionPending' },
      { type: 'Elapsed', ms: 60_000 },
      { type: 'Osc133', text: '\u001b]133;A\u0007' },
      { type: 'ProcessExit' }
    ]
    for (const event of events) {
      expectIgnored(exited.state, event)
      expectIgnored({ ...exited.state, mode: 'raw' }, event)
      expectIgnored({ ...exited.state, alive: true }, event)
    }
  })

  it('completion pending is ignored outside a trusted prompt', () => {
    const invalidStates: Partial<SessionState>[] = [
      { mode: 'raw' },
      { mode: 'PTY' },
      { mode: 'exited' },
      { alive: false },
      { phase: 'Unknown' },
      { phase: 'Submitting' },
      { phase: 'Executing' },
      { phase: 'Terminated' },
      { trusted: false },
      { committedSubmit: true },
      { alternateScreen: true }
    ]
    for (const overrides of invalidStates) {
      const state = registeredSession({ mode: 'Editor', phase: 'AtPrompt', ...overrides })
      const result = reduceSession(state, { type: 'CompletionPending' })
      expect(result.state.completionPending).toBe(false)
      expectIgnored(state, { type: 'CompletionPending' })
    }
  })

  it('a submit clears a pending completion', () => {
    const pending = reduceSession(registeredSession({ mode: 'Editor', phase: 'AtPrompt' }), {
      type: 'CompletionPending'
    })
    expect(pending.state.completionPending).toBe(true)
    expect(pending.state.phase).toBe('AtPrompt')
    const result = reduceSession(
      { ...pending.state, committedSubmit: true },
      {
        type: 'CommandStarted',
        sessionId: SESSION_ID,
        nonce: NONCE
      }
    )
    expect(result.state.completionPending).toBe(false)
    expect(result.state.phase).toBe('Executing')
    expect(result.writeDraft).toBe(false)
  })

  it('leaving a trusted prompt clears a pending completion', () => {
    const events: SessionEvent[] = [
      { type: 'AlternateScreenEnter' },
      { type: 'Desync' },
      { type: 'IntegrationLost' },
      { type: 'ProcessExit' },
      { type: 'CommandFinished', sessionId: SESSION_ID, nonce: NONCE, exit_code: 0 }
    ]
    for (const event of events) {
      const result = reduceSession(
        registeredSession({
          mode: 'Editor',
          phase: 'AtPrompt',
          completionPending: true,
          committedSubmit: true
        }),
        event
      )
      expect(result.state.completionPending).toBe(false)
      expect(result.writeDraft).toBe(false)
    }
  })

  it('a fallback during a submission recovers on the final prompt', () => {
    for (const type of ['Desync', 'IntegrationLost'] as const) {
      const fallback = reduceSession(
        registeredSession({
          mode: 'PTY',
          phase: 'Submitting',
          committedSubmit: true,
          buffer: 'git status',
          promptGeneration: 1
        }),
        { type }
      )
      expect(fallback.state.mode).toBe('raw')
      expect(fallback.state.trusted).toBe(false)
      expect(fallback.state.committedSubmit).toBe(true)
      expect(fallback.writeDraft).toBe(false)
      expectIgnored(fallback.state, promptEvent(2))
      const intermediate = reduceSession(fallback.state, promptEvent(2))
      const finished = reduceSession(intermediate.state, {
        type: 'CommandFinished',
        sessionId: SESSION_ID,
        nonce: NONCE,
        exit_code: 0
      })
      expect(finished.state.phase).toBe('Executing')
      expect(finished.state.mode).toBe('raw')
      expect(finished.state.committedSubmit).toBe(true)
      expect(finished.state.lastExitCode).toBe(0)
      expect(finished.writeDraft).toBe(false)
      const result = reduceSession(finished.state, promptEvent(3))
      expect(result.state.mode).toBe('Editor')
      expect(result.state.phase).toBe('AtPrompt')
      expect(result.state.buffer).toBe('')
      expect(result.state.committedSubmit).toBe(false)
      expect(result.state.trusted).toBe(true)
      expect(result.state.promptGeneration).toBe(3)
      expect(result.writeDraft).toBe(false)
    }
  })

  it('newer prompt while submitting opens an empty editor', () => {
    const state = registeredSession({
      mode: 'PTY',
      phase: 'Submitting',
      committedSubmit: false,
      buffer: 'git status',
      promptGeneration: 1
    })
    expectIgnored(state, promptEvent(1))
    const result = reduceSession(state, promptEvent(2))
    expect(result.state.mode).toBe('Editor')
    expect(result.state.phase).toBe('AtPrompt')
    expect(result.state.buffer).toBe('')
    expect(result.state.committedSubmit).toBe(false)
    expect(result.state.promptGeneration).toBe(2)
  })
})
