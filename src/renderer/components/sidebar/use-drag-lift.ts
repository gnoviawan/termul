import { useCallback, useEffect, useRef, useState } from 'react'

// Reorder's snap-back spring runs up to ~0.9s after a long drag (measured in
// the rail), so a shorter fallback would drop the lift mid-flight.
export const DRAG_LIFT_FALLBACK_MS = 1200

/**
 * Which rail row is lifted (opaque bg + shadow) while it is dragged and
 * springs back. Motion's onDragTransitionEnd normally settles it, but that
 * never fires if the row unmounts or moves lists first, so release() also
 * arms a fallback timer.
 */
export function useDragLift(): {
  liftedId: string | null
  lift: (id: string) => void
  release: (id: string) => void
  settle: (id: string) => void
} {
  const [liftedId, setLiftedId] = useState<string | null>(null)
  const fallback = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelFallback = useCallback(() => {
    if (fallback.current === null) return
    clearTimeout(fallback.current)
    fallback.current = null
  }, [])

  useEffect(() => cancelFallback, [cancelFallback])

  const settle = useCallback(
    (id: string) => {
      cancelFallback()
      setLiftedId((current) => (current === id ? null : current))
    },
    [cancelFallback]
  )

  const lift = useCallback(
    (id: string) => {
      cancelFallback()
      setLiftedId(id)
    },
    [cancelFallback]
  )

  const release = useCallback(
    (id: string) => {
      cancelFallback()
      fallback.current = setTimeout(() => {
        fallback.current = null
        setLiftedId((current) => (current === id ? null : current))
      }, DRAG_LIFT_FALLBACK_MS)
    },
    [cancelFallback]
  )

  return { liftedId, lift, release, settle }
}
