import { describe, expect, it } from 'vitest'
import {
  createTerminalIdleNotifyState,
  evaluateTerminalIdleNotify,
  isViewingTerminal,
  recordTerminalOutput,
  TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS,
  TERMINAL_IDLE_NOTIFY_QUIET_MS
} from './terminal-idle-notify'

describe('terminal idle notify state machine', () => {
  const opts = {
    quietMs: TERMINAL_IDLE_NOTIFY_QUIET_MS,
    minBusyMs: TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS
  }

  it('does not notify before any output', () => {
    const state = createTerminalIdleNotifyState()
    expect(evaluateTerminalIdleNotify(state, 10_000, opts).kind).toBe('none')
  })

  it('does not notify while output is still arriving', () => {
    let state = createTerminalIdleNotifyState()
    state = recordTerminalOutput(state, 0)
    state = recordTerminalOutput(state, TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS)
    expect(
      evaluateTerminalIdleNotify(state, TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS + 1_000, opts).kind
    ).toBe('none')
  })

  it('does not notify a short burst that then goes quiet (ls, git status)', () => {
    let state = createTerminalIdleNotifyState()
    state = recordTerminalOutput(state, 0)
    const afterQuiet = 2_000 + TERMINAL_IDLE_NOTIFY_QUIET_MS
    expect(evaluateTerminalIdleNotify(state, afterQuiet, opts).kind).toBe('none')
  })

  it('does not count the quiet stretch toward the busy threshold', () => {
    // Output spans only minBusyMs - quietMs, so the burst is too short even
    // though the wall-clock gap from the first chunk reaches minBusyMs.
    const lastOutput = TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS - TERMINAL_IDLE_NOTIFY_QUIET_MS
    let state = createTerminalIdleNotifyState()
    state = recordTerminalOutput(state, 0)
    state = recordTerminalOutput(state, lastOutput)
    const now = lastOutput + TERMINAL_IDLE_NOTIFY_QUIET_MS
    expect(now).toBe(TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS)
    expect(evaluateTerminalIdleNotify(state, now, opts).kind).toBe('none')
  })

  it('notifies after a long busy period then quiet', () => {
    let state = createTerminalIdleNotifyState()
    state = recordTerminalOutput(state, 0)
    state = recordTerminalOutput(state, TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS)
    const now = TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS + TERMINAL_IDLE_NOTIFY_QUIET_MS
    const result = evaluateTerminalIdleNotify(state, now, opts)
    expect(result.kind).toBe('notify')
  })

  it('does not notify twice for the same busy period', () => {
    let state = createTerminalIdleNotifyState()
    state = recordTerminalOutput(state, 0)
    state = recordTerminalOutput(state, TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS)
    const now = TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS + TERMINAL_IDLE_NOTIFY_QUIET_MS
    const first = evaluateTerminalIdleNotify(state, now, opts)
    expect(first.kind).toBe('notify')
    if (first.kind !== 'notify') return
    const second = evaluateTerminalIdleNotify(first.next, now + 1, opts)
    expect(second.kind).toBe('none')
  })

  it('notifies again after a new long busy period', () => {
    let state = createTerminalIdleNotifyState()
    state = recordTerminalOutput(state, 0)
    state = recordTerminalOutput(state, TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS)
    const firstAt = TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS + TERMINAL_IDLE_NOTIFY_QUIET_MS
    const first = evaluateTerminalIdleNotify(state, firstAt, opts)
    expect(first.kind).toBe('notify')
    if (first.kind !== 'notify') return

    const restart = firstAt + 1_000
    state = recordTerminalOutput(first.next, restart)
    state = recordTerminalOutput(state, restart + TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS)
    const secondAt = restart + TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS + TERMINAL_IDLE_NOTIFY_QUIET_MS
    expect(evaluateTerminalIdleNotify(state, secondAt, opts).kind).toBe('notify')
  })
})

describe('isViewingTerminal', () => {
  it('is true only when this tab is active, the window is focused, and the app is visible', () => {
    expect(
      isViewingTerminal({
        activeTerminalId: 't1',
        terminalId: 't1',
        windowFocused: true,
        isAppHidden: false
      })
    ).toBe(true)
  })

  it('is false for a background tab', () => {
    expect(
      isViewingTerminal({
        activeTerminalId: 't1',
        terminalId: 't2',
        windowFocused: true,
        isAppHidden: false
      })
    ).toBe(false)
  })

  it('is false when the window is unfocused', () => {
    expect(
      isViewingTerminal({
        activeTerminalId: 't1',
        terminalId: 't1',
        windowFocused: false,
        isAppHidden: false
      })
    ).toBe(false)
  })

  it('is false when the app is hidden', () => {
    expect(
      isViewingTerminal({
        activeTerminalId: 't1',
        terminalId: 't1',
        windowFocused: true,
        isAppHidden: true
      })
    ).toBe(false)
  })
})
