import { useCallback, useEffect, useReducer, useRef } from 'react'

/** How long a Compact click may stay pending before the button gives up. */
export const COMPACT_TIMEOUT_MS = 60_000

export type CompactPhase = 'idle' | 'pending' | 'failed'

export interface CompactState {
  phase: CompactPhase
  /** True once the agent showed it picked the request up (turn or compaction marker). */
  sawActivity: boolean
  /** `usage.updatedAt` at the moment of failure; the error clears on the next report. */
  failedAtUsage: number | null
}

export interface CompactSignals {
  /** False when the session is not `active` (closed, error, reconnecting). */
  connected: boolean
  activeTurn: boolean
  compaction: 'started' | 'failed' | null
  usageUpdatedAt: number | null
}

export type CompactEvent =
  | { type: 'request' }
  | { type: 'timeout'; usageUpdatedAt: number | null }
  | { type: 'signals'; signals: CompactSignals }

export const INITIAL_COMPACT_STATE: CompactState = {
  phase: 'idle',
  sawActivity: false,
  failedAtUsage: null
}

export function compactReducer(state: CompactState, event: CompactEvent): CompactState {
  switch (event.type) {
    case 'request':
      if (state.phase === 'pending') return state
      return { phase: 'pending', sawActivity: false, failedAtUsage: null }
    case 'timeout':
      if (state.phase !== 'pending') return state
      return { phase: 'failed', sawActivity: false, failedAtUsage: event.usageUpdatedAt }
    case 'signals': {
      const { connected, activeTurn, compaction, usageUpdatedAt } = event.signals
      if (state.phase === 'failed') {
        // A disconnect or a fresh usage report clears the error line.
        if (!connected || usageUpdatedAt !== state.failedAtUsage) return INITIAL_COMPACT_STATE
        return state
      }
      if (state.phase !== 'pending') return state
      if (!connected) return INITIAL_COMPACT_STATE
      if (compaction === 'failed') {
        return { phase: 'failed', sawActivity: false, failedAtUsage: usageUpdatedAt }
      }
      const busy = activeTurn || compaction === 'started'
      if (busy) return state.sawActivity ? state : { ...state, sawActivity: true }
      // The turn ran and ended without a failure marker: compaction is done.
      if (state.sawActivity) return INITIAL_COMPACT_STATE
      return state
    }
  }
}

/**
 * Pending state for the Compact button. It never sticks: a disconnect resets
 * it at once, and after COMPACT_TIMEOUT_MS it turns into a failure line.
 */
export function useCompactRequest(
  signals: CompactSignals,
  send: (() => void) | undefined
): { phase: CompactPhase; request: () => void } {
  const [state, dispatch] = useReducer(compactReducer, INITIAL_COMPACT_STATE)
  const { connected, activeTurn, compaction, usageUpdatedAt } = signals
  const usageRef = useRef(usageUpdatedAt)
  usageRef.current = usageUpdatedAt

  useEffect(() => {
    dispatch({ type: 'signals', signals: { connected, activeTurn, compaction, usageUpdatedAt } })
  }, [connected, activeTurn, compaction, usageUpdatedAt])

  // The clock waits while the agent reports compaction running.
  const compacting = compaction === 'started'
  useEffect(() => {
    if (state.phase !== 'pending' || compacting) return
    const timer = setTimeout(
      () => dispatch({ type: 'timeout', usageUpdatedAt: usageRef.current }),
      COMPACT_TIMEOUT_MS
    )
    return () => clearTimeout(timer)
  }, [state.phase, compacting])

  // A ref, not `state.phase`: two clicks in the same tick both see a stale phase.
  const pendingRef = useRef(false)
  pendingRef.current = state.phase === 'pending'
  const request = useCallback(() => {
    if (!send || pendingRef.current) return
    pendingRef.current = true
    dispatch({ type: 'request' })
    send()
  }, [send])

  return { phase: state.phase, request }
}
