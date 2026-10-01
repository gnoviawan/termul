import { useEffect, useRef } from 'react'

/**
 * Multi-project perf render gate: the call site keeps its live store
 * subscription (the store stays the single source of truth — coalesced
 * flushes keep landing while the host tab is hidden), but while
 * `isVisible` is false this returns the last value seen while visible, so
 * hidden panels skip per-flush derived work (timeline memos, Streamdown
 * re-parses). The value re-syncs during the first visible render.
 *
 * Render stays pure: the snapshot is written after commit (a passive
 * effect), so an abandoned visible render can never leak its uncommitted
 * value into the frozen snapshot a hidden render reads.
 *
 * Contract: when the gated value's owner can change in place (e.g. a chat
 * tab whose session is remapped without remounting), the frozen snapshot may
 * hold the previous owner's value while hidden — safe, because it is only
 * returned while hidden and the first visible render returns the live value.
 */
export function useVisibleSnapshot<T>(isVisible: boolean, value: T): T {
  const ref = useRef(value)
  useEffect(() => {
    if (isVisible) {
      ref.current = value
    }
  }, [isVisible, value])
  return isVisible ? value : ref.current
}
