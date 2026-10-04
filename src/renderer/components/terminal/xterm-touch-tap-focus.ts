import type { Terminal } from '@xterm/xterm'

/**
 * xterm 6.1's vendored Gesture singleton listens on `document` for
 * touchstart/touchend/touchmove (non-passive). For any touch whose target is
 * inside `.xterm-screen` it calls `preventDefault()` + `stopPropagation()`,
 * which cancels the compatibility `mousedown`/`click`. xterm only focuses its
 * helper textarea from `mousedown`, so after the terminal blurs a tap never
 * refocuses it and the mobile keyboard stays closed. Mouse clicks still take
 * the mousedown path.
 *
 * A passive `touchend` on the terminal element runs before that document
 * listener and calls `terminal.focus()` (textarea.focus({ preventScroll: true }))
 * for a tap only. Drags beyond xterm's own TAP slop and long-presses are left
 * alone so touch scrolling and text selection keep working. Listeners are
 * touch-only, so desktop mouse input is unchanged.
 *
 * Thresholds match Gesture: TAP when movement < 30px and duration < 700ms
 * (`Gesture._holdDelay` / the rolling-distance check in `_handleTouchEnd`).
 */

/** xterm Gesture TAP distance slop, in CSS pixels. */
const TAP_MAX_DISTANCE_PX = 30

/** xterm Gesture hold delay. At or above this, a stationary touch is a long-press. */
const TAP_MAX_DURATION_MS = 700

const boundElements = new WeakSet<HTMLElement>()

interface TapGesture {
  x: number
  y: number
  startedAt: number
  moved: boolean
}

function withinTapSlop(dx: number, dy: number): boolean {
  return dx * dx + dy * dy < TAP_MAX_DISTANCE_PX * TAP_MAX_DISTANCE_PX
}

function focusAlreadyInside(element: HTMLElement): boolean {
  const active = element.ownerDocument.activeElement
  return active !== null && active !== element.ownerDocument.body && element.contains(active)
}

/**
 * Focus the terminal when a touch tap lands on it. Idempotent per xterm root
 * element, including terminals restored from the session cache (same element).
 * No-ops when `open()` has not created `terminal.element` yet.
 */
export function bindXtermTouchTapFocus(terminal: Terminal): void {
  const element = terminal.element
  if (!element || boundElements.has(element)) return
  boundElements.add(element)

  let gesture: TapGesture | null = null

  const onTouchStart = (event: TouchEvent): void => {
    const touch = event.touches[0]
    if (event.touches.length !== 1 || !touch) {
      gesture = null
      return
    }
    gesture = {
      x: touch.clientX,
      y: touch.clientY,
      startedAt: performance.now(),
      moved: false
    }
  }

  const onTouchMove = (event: TouchEvent): void => {
    if (!gesture) return
    const touch = event.touches[0]
    if (event.touches.length !== 1 || !touch) {
      gesture = null
      return
    }
    if (!withinTapSlop(touch.clientX - gesture.x, touch.clientY - gesture.y)) {
      gesture.moved = true
    }
  }

  const onTouchEnd = (event: TouchEvent): void => {
    const current = gesture
    gesture = null
    const touch = event.changedTouches[0]
    if (!current || current.moved || event.changedTouches.length !== 1 || !touch) return
    if (!withinTapSlop(touch.clientX - current.x, touch.clientY - current.y)) return
    if (performance.now() - current.startedAt >= TAP_MAX_DURATION_MS) return
    if (focusAlreadyInside(element)) return
    terminal.focus()
  }

  const onTouchCancel = (): void => {
    gesture = null
  }

  element.addEventListener('touchstart', onTouchStart, { passive: true })
  element.addEventListener('touchmove', onTouchMove, { passive: true })
  element.addEventListener('touchend', onTouchEnd, { passive: true })
  element.addEventListener('touchcancel', onTouchCancel, { passive: true })
}
