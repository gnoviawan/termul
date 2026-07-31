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
 * Baseline-protection heuristic: capture `window.innerHeight` at first effect
 * run BEFORE any OSK event fires. When the OSK opens,
 * `keyboardHeight = max(0, baseline - visualViewport.height)`. Skip baseline
 * updates while iOS `offsetTop > 0` (the OSK has scrolled the visual viewport
 * — capturing now would lock in the shrunk height forever). Re-capture the
 * baseline only when the OSK closes (offsetTop returns to 0).
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
  /** True when the OSK is open (visual-viewport height shrunk vs baseline). */
  isOskOpen: boolean
  /** OSK height in CSS pixels (`max(0, baseline - visualViewport.height)`). */
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
 * pass the captured baseline and the live `VisualViewport` (or null).
 *
 * Baseline is `window.innerHeight` (the layout viewport), captured BEFORE any
 * OSK event fires. `keyboardHeight = max(0, baseline - vv.height)`.
 *
 * `isOskOpen` is true when either the keyboard height is positive OR the
 * visual viewport has scrolled upward (iOS `offsetTop > 0`).
 */
export function resolveOskState(baseline: number, vv: VisualViewport | null): OskState {
  if (!vv) {
    return {
      height: baseline,
      offsetTop: 0,
      isOskOpen: false,
      keyboardHeight: 0
    }
  }
  const height = vv.height
  const offsetTop = vv.offsetTop
  const keyboardHeight = Math.max(0, baseline - height)
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

    // Baseline = window.innerHeight (the LAYOUT viewport — unaffected by OSK
    // on iOS Safari). Re-capture only when the OSK closes (offsetTop 0 and
    // height restored) so a baseline that drifted due to orientation change
    // while the OSK was open gets refreshed. We never overwrite the baseline
    // while offsetTop > 0 — that would lock in the shrunk height forever.
    let baseline = window.innerHeight
    let rafId: number | null = null

    const apply = (): void => {
      rafId = null
      const next = resolveOskState(baseline, vv)
      if (!next.isOskOpen) {
        // OSK closed — refresh the baseline so orientation changes don't
        // leave us with a stale reference.
        baseline = window.innerHeight
      }
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
