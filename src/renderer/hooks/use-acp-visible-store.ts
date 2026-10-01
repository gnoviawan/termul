import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { type AcpState, useAcpStore } from '@/stores/acp-store'

/** Empty fallback for mocked-store test environments (no getState). */
const EMPTY_STATE = {} as AcpState

/**
 * Read the live store state, tolerating component tests that mock
 * `@/stores/acp-store` with a bare selector function (no zustand statics).
 */
function readState(): AcpState {
  return typeof useAcpStore.getState === 'function' ? useAcpStore.getState() : EMPTY_STATE
}

/**
 * Visibility-gated store selector for host panels that stay mounted while
 * their tab is hidden. Companion to `useVisibleSnapshot`: that hook freezes
 * the VALUE while hidden but still pays a render pass per store flush (the
 * selector fires, the result is the same ref, React still runs the
 * component's bail-out path). This hook suppresses the store NOTIFY while
 * hidden, so a hidden chat panel's selectors cost zero React work per flush —
 * the dominant per-event cost under an N-agent stream where every mounted
 * panel subscribes to the same store.
 *
 * The store subscription stays armed (event → set() lands as usual; the store
 * remains the single source of truth); while hidden the component simply
 * isn't told. When the tab becomes active the parent re-renders this panel
 * with `isVisible=true`, `useSyncExternalStore` re-reads the now-current
 * snapshot during that render, and everything streamed while hidden arrives
 * in one commit — the same re-sync contract `useVisibleSnapshot` documents.
 *
 * While hidden the hook returns the last visible value (freeze semantics), so
 * callers never observe live-but-unrendered data.
 */
export function useAcpStoreVisible<T>(selector: (state: AcpState) => T, isVisible: boolean): T {
  const visibleRef = useRef(isVisible)
  // Post-commit write (not render-phase): React can abandon a render, and a
  // ref write during an abandoned render would still flip the gate read by
  // the armed subscription below — dropping notifies for a consumer whose
  // committed visibility is still true. useLayoutEffect ties the update to
  // the committed tree.
  useLayoutEffect(() => {
    visibleRef.current = isVisible
  }, [isVisible])

  // Stable subscribe fn: notifies React only while visible. The subscription
  // itself is a plain zustand listener — suppressed notifies simply skip the
  // render; no event is lost because getSnapshot re-reads the store on the
  // next (visibility-flip) render. When the store is vi.mocked (no
  // `subscribe`), register a no-op so tests render the mock's snapshot.
  const subscribe = useCallback((onStoreChange: () => void) => {
    if (typeof useAcpStore.subscribe !== 'function') return () => {}
    return useAcpStore.subscribe(() => {
      if (visibleRef.current) onStoreChange()
    })
  }, [])

  const live = useSyncExternalStore(subscribe, () => selector(readState()))

  // Freeze contract: return the last visible value while hidden. Written in
  // an effect (not during render) so an abandoned visible render cannot leak
  // its uncommitted value into the frozen snapshot — mirrors
  // useVisibleSnapshot's purity guarantee.
  const frozenRef = useRef(live)
  useEffect(() => {
    if (isVisible) frozenRef.current = live
  }, [isVisible, live])

  return isVisible ? live : frozenRef.current
}
