/**
 * Story 5.3 — `visualViewport`-aware on-screen-keyboard (OSK) hook.
 *
 * Subscribes to `window.visualViewport` `resize` AND `scroll` events (both
 * required for iOS Safari, which scrolls the visual viewport upward instead
 * of resizing the layout viewport like Android Chrome 108+).
 *
 * Why both events:
 * - iOS Safari: `visualViewport.height` shrinks AND `offsetTop` increases.
 *   `window.resize` does NOT fire on iOS for OSK open/close. We need both
 *   `resize` and `scroll` events on `visualViewport` itself.
 * - Android Chrome 108+ with `interactive-widget=resizes-content`: the
 *   layout viewport shrinks (`window.innerHeight` decreases), `visualViewport
 *   .offsetTop` stays 0. `visualViewport.resize` fires.
 *
 * Current-values spacer (#852): `keyboardHeight = max(0, window.innerHeight
 * - visualViewport.height)` where BOTH values are read at the same instant —
 * deliberately NOT a pre-OSK baseline. On Android Chrome with
 * `interactive-widget=resizes-content` the layout viewport already shrank to
 * sit on top of the keyboard, so `innerHeight ≈ visualViewport.height` and
 * the spacer collapses to ~0: the keyboard height is NOT compensated a
 * second time (the old pre-OSK baseline formula returned the full keyboard
 * height again on top of the shrunken layout, collapsing the chat transcript
 * behind a giant gap). On iOS Safari (and on Android without the meta /
 * with `resizes-visual`), the layout viewport does NOT shrink, so the
 * difference IS the keyboard height and the spacer is genuinely needed.
 *
 * Capability guard: `window.visualViewport` has 95%+ global support (caniuse)
 * but is absent in older mobile Safari/WebView and in jsdom without a stub.
 * Guard `typeof window === 'undefined' || !window.visualViewport` and return
 * a no-OSK default so the hook never throws on Tauri desktop or older
 * browsers. Mirrors the capability-guard pattern from `theme-appearance.ts`
 * (Story 5.1 lesson).
 *
 * CSS var: mirrors `keyboardHeight` to `--termul-keyboard-height` on
 * `document.documentElement` so consumers can size OSK-aware spacers via CSS
 * without re-reading React state (CSS viewport units `vh`/`dvh` ignore the
 * OSK — see Dev Notes anti-patterns).
 *
 * Throttle: `resize` and `scroll` fire rapidly during OSK open/close
 * transitions. Coalesce via `requestAnimationFrame` to avoid layout thrash.
 */

import { useEffect, useState } from 'react'

export interface OskState {
  /** Current visual-viewport height in CSS pixels. */
  height: number
  /** Current visual-viewport top offset (iOS scrolls upward when OSK opens). */
  offsetTop: number
  /** True when the OSK is open (spacer height positive or iOS offsetTop > 0). */
  isOskOpen: boolean
  /**
   * OSK spacer height in CSS pixels: `max(0, layoutViewportHeight -
   * visualViewport.height)` with both values read at the same instant. ~0
   * when the layout viewport already shrank onto the keyboard (Android
   * `resizes-content`); the full keyboard height when it did not (iOS, or
   * Android `resizes-visual`). Consumers add this as bottom padding so the
   * composer clears the keys — see #852.
   */
  keyboardHeight: number
}

const NO_OSK: OskState = {
  height: 0,
  offsetTop: 0,
  isOskOpen: false,
  keyboardHeight: 0
}

/**
 * Pure helper for unit tests and non-React callers. No DOM access — callers
 * pass the CURRENT layout-viewport height (`window.innerHeight`, read at the
 * same instant as the visual viewport) and the live `VisualViewport` (or
 * null).
 *
 * `keyboardHeight = max(0, layoutViewportHeight - vv.height)`.
 *
 * `isOskOpen` is true when either the spacer height is positive OR the
 * visual viewport has scrolled upward (iOS `offsetTop > 0`).
 */
export function resolveOskState(layoutViewportHeight: number, vv: VisualViewport | null): OskState {
  if (!vv) {
    return {
      height: layoutViewportHeight,
      offsetTop: 0,
      isOskOpen: false,
      keyboardHeight: 0
    }
  }
  const height = vv.height
  const offsetTop = vv.offsetTop
  const keyboardHeight = Math.max(0, layoutViewportHeight - height)
  const isOskOpen = keyboardHeight > 0 || offsetTop > 0
  return { height, offsetTop, isOskOpen, keyboardHeight }
}

function writeKeyboardHeightVar(keyboardHeight: number): void {
  if (typeof document === 'undefined' || !document.documentElement) return
  document.documentElement.style.setProperty('--termul-keyboard-height', `${keyboardHeight}px`)
}

/**
 * React hook returning the current OSK state. Subscribes to
 * `window.visualViewport` `resize` + `scroll` (both required for iOS).
 *
 * Returns a no-OSK default on Tauri desktop / older browsers without
 * `visualViewport`. See module docstring for the capability guard rationale.
 *
 * Side effect: mirrors `keyboardHeight` to the `--termul-keyboard-height` CSS
 * custom property on `document.documentElement` so CSS-only consumers (e.g.
 * the chat-message-list spacer) can react without re-rendering React.
 */
export function useOskViewport(): OskState {
  const [state, setState] = useState<OskState>(() => {
    if (typeof window === 'undefined' || !window.visualViewport) {
      return { ...NO_OSK, height: window?.innerHeight ?? 0 }
    }
    return resolveOskState(window.innerHeight, window.visualViewport)
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return
    const vv = window.visualViewport
    let rafId: number | null = null

    const apply = (): void => {
      rafId = null
      // #852: read `window.innerHeight` LIVE at apply time — no pre-OSK
      // baseline. On Android Chrome with `interactive-widget=resizes-content`
      // the layout viewport shrinks onto the keyboard together with the
      // visual viewport, so the difference collapses to ~0 and the
      // consumers' spacer stops double-compensating. On iOS Safari (and
      // Android without resizes-content) `innerHeight` is unaffected by the
      // OSK and the difference is the real keyboard height. Orientation
      // changes while the OSK is open are handled for free: both values are
      // re-read together on every event.
      const next = resolveOskState(window.innerHeight, vv)
      writeKeyboardHeightVar(next.keyboardHeight)
      setState(next)
    }

    const scheduleApply = (): void => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(apply)
    }

    // Both `resize` and `scroll` are required for iOS Safari compatibility
    // (iOS scrolls the visual viewport upward; `resize` alone misses the
    // early scroll phase of the OSK-open transition).
    vv.addEventListener('resize', scheduleApply)
    vv.addEventListener('scroll', scheduleApply)

    // Capture initial state in case the OSK was already open at mount.
    scheduleApply()

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      vv.removeEventListener('resize', scheduleApply)
      vv.removeEventListener('scroll', scheduleApply)
      // Reset the CSS var so it doesn't leak into non-OSK contexts.
      writeKeyboardHeightVar(0)
    }
  }, [])

  return state
}
