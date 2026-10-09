import { type MouseEvent, type PointerEvent, type TouchEvent, useRef } from 'react'

/** Max finger travel (px) for a touchend to count as a tap, not a drag-scroll. */
const TOUCH_SELECT_THRESHOLD_PX = 10

/** How long a tap blocks the click that the browser synthesizes after it. */
const TOUCH_CLICK_GUARD_MS = 500

export interface TapSelectHandlers {
  onTouchStart: (event: TouchEvent) => void
  onTouchEnd: (event: TouchEvent) => void
  onClick: (event: MouseEvent) => void
}

/**
 * Touch-safe selection for picker option rows (Story 5.3 T4.2). `touchend`
 * selects only when the finger stayed within a small radius of `touchstart`,
 * so a drag-scroll through the list does not select. After a tap, the click
 * that the browser synthesizes is ignored, so one tap selects exactly once.
 *
 * Returns a factory: call it per row with that row's select callback. One
 * hook instance per list (the guard is shared across its rows).
 */
export function useTapSelect(): (select: () => void) => TapSelectHandlers {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const lastInputType = useRef<'touch' | null>(null)

  return (select) => ({
    onTouchStart: (event) => {
      const t = event.touches[0]
      if (t) touchStartRef.current = { x: t.clientX, y: t.clientY }
    },
    onTouchEnd: (event) => {
      event.preventDefault()
      const start = touchStartRef.current
      touchStartRef.current = null
      const t = event.changedTouches[0]
      const isTap =
        start && t
          ? (t.clientX - start.x) ** 2 + (t.clientY - start.y) ** 2 <=
            TOUCH_SELECT_THRESHOLD_PX ** 2
          : true
      if (!isTap) return
      lastInputType.current = 'touch'
      select()
      window.setTimeout(() => {
        if (lastInputType.current === 'touch') lastInputType.current = null
      }, TOUCH_CLICK_GUARD_MS)
    },
    onClick: (event) => {
      if (lastInputType.current === 'touch') return
      event.preventDefault()
      select()
    }
  })
}

/**
 * Keep focus where it is on a primary mouse press (the popover search field
 * or trigger). Selection happens on click, so a drag off the row cancels.
 */
export function keepFocusOnMousePress(event: PointerEvent): void {
  if (event.pointerType === 'touch') return
  if ((event.button ?? 0) !== 0) return
  event.preventDefault()
}
