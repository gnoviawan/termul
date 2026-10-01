/**
 * Idle-detection for “agent finished in a terminal tab” notifications (GH-645).
 *
 * A PTY is treated as busy while it keeps producing output. After `quietMs`
 * of silence, a notification is warranted only if that busy stretch lasted
 * at least `minBusyMs` — so a quick `ls` does not ping the OS.
 */

/** Silence after the last PTY chunk before we consider the burst finished. */
export const TERMINAL_IDLE_NOTIFY_QUIET_MS = 8_000

/**
 * Minimum time from the first chunk of a burst to the last. Agent turns take
 * tens of seconds to minutes; this filters interactive one-shot commands.
 */
export const TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS = 20_000

export type TerminalIdleNotifyState = {
  busySince: number | null
  lastOutputAt: number | null
}

export function createTerminalIdleNotifyState(): TerminalIdleNotifyState {
  return { busySince: null, lastOutputAt: null }
}

export function recordTerminalOutput(
  state: TerminalIdleNotifyState,
  now: number
): TerminalIdleNotifyState {
  if (state.busySince === null) {
    return { busySince: now, lastOutputAt: now }
  }
  return { ...state, lastOutputAt: now }
}

export type TerminalIdleNotifyEval = {
  kind: 'none' | 'notify'
  next: TerminalIdleNotifyState
}

export function evaluateTerminalIdleNotify(
  state: TerminalIdleNotifyState,
  now: number,
  opts: { quietMs: number; minBusyMs: number }
): TerminalIdleNotifyEval {
  const idle = createTerminalIdleNotifyState()
  const { busySince, lastOutputAt } = state
  if (busySince === null || lastOutputAt === null) {
    return { kind: 'none', next: state }
  }
  if (now - lastOutputAt < opts.quietMs) {
    return { kind: 'none', next: state }
  }
  // Span of actual output, not wall-clock: `now` already includes `quietMs`, so
  // using it here would let a burst reach the threshold while sitting silent.
  if (lastOutputAt - busySince < opts.minBusyMs) {
    return { kind: 'none', next: idle }
  }
  return { kind: 'notify', next: idle }
}

export function isViewingTerminal(opts: {
  activeTerminalId: string
  terminalId: string
  windowFocused: boolean
  isAppHidden: boolean
}): boolean {
  return opts.activeTerminalId === opts.terminalId && opts.windowFocused && !opts.isAppHidden
}
