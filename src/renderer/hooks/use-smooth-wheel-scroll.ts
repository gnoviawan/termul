/**
 * Mounts the smooth inertial wheel interceptor (`@/lib/smooth-wheel`) on
 * `document` for the app shell's lifetime. Wired into BOTH renderer roots'
 * `AppEffects` (`App.tsx` + `TauriApp.tsx`) so desktop, web, and
 * mobile-browser surfaces share the same wheel-scroll feel — including
 * portaled Radix surfaces, whose wheel events bubble to `document`
 * regardless of where the portal mounts.
 *
 * Wheel input only: touch scrolling (`touchmove` is already inertial
 * natively), keyboard scrolling (Space/PageUp/arrows), and scrollbar drags
 * are unaffected and stay fully native.
 *
 * Inert under `prefers-reduced-motion`: the listener simply isn't
 * installed, so scrolling stays fully native (and a live preference change
 * attaches/detaches it). Installs are refcounted per document, so
 * concurrent mounts are safe.
 */

import { useReducedMotion } from 'framer-motion'
import { useEffect } from 'react'
import { installSmoothWheelScroll } from '@/lib/smooth-wheel'

export function useSmoothWheelScroll(): void {
  const reducedMotion = useReducedMotion() ?? false

  useEffect(() => {
    if (reducedMotion || typeof document === 'undefined') return
    return installSmoothWheelScroll(document)
  }, [reducedMotion])
}
