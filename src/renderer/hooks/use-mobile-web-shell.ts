/**
 * Detects whether the renderer should use the ChatGPT-style mobile web shell
 * (Epic 5 follow-up): hide ActivityRail / TitleBar / persistent sidebar / tab
 * strip. Desktop Tauri always keeps the full IDE chrome.
 *
 * Viewport breakpoint (not pane width) — shell chrome is viewport-level.
 */

import { useEffect, useState } from 'react'
import { isTauriContext } from '@/lib/tauri-runtime'

/** Viewport max-width (px) for the mobile web shell. */
export const MOBILE_WEB_SHELL_MAX_PX = 767

const MOBILE_QUERY = `(max-width: ${MOBILE_WEB_SHELL_MAX_PX}px)`

/**
 * Pure helper for tests and non-React callers.
 * Returns false inside Tauri regardless of viewport.
 */
export function resolveMobileWebShell(isTauri: boolean, matchesNarrowViewport: boolean): boolean {
  if (isTauri) return false
  return matchesNarrowViewport
}

/**
 * True when running in the browser (not Tauri) on a narrow viewport.
 * Subscribes to `matchMedia` so orientation / resize updates live.
 */
export function useMobileWebShell(): boolean {
  const [active, setActive] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return resolveMobileWebShell(isTauriContext(), window.matchMedia(MOBILE_QUERY).matches)
  })

  useEffect(() => {
    if (isTauriContext()) {
      setActive(false)
      return
    }

    if (typeof window.matchMedia !== 'function') return

    const mql = window.matchMedia(MOBILE_QUERY)
    const apply = (event?: MediaQueryListEvent): void => {
      setActive(resolveMobileWebShell(false, event?.matches ?? mql.matches))
    }
    apply()

    const onChange = (event: MediaQueryListEvent): void => apply(event)
    // `addEventListener` is the modern path; older iOS Safari only exposes the
    // deprecated `addListener` alias — fall back to it so the shell still
    // tracks orientation changes on the mobile browsers this hook targets.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(onChange)
      return () => mql.removeListener(onChange)
    }
    return
  }, [])

  return active
}
