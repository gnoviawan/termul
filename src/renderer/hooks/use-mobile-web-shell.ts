/**
 * Detects whether the renderer should use the ChatGPT-style mobile web shell
 * (Epic 5 follow-up): hide ActivityRail / TitleBar / persistent sidebar / tab
 * strip. Desktop Tauri always keeps the full IDE chrome.
 *
 * Viewport breakpoint (not pane width) — shell chrome is viewport-level.
 *
 * Story 7 (QA P2 landscape): width alone misclassifies a landscape phone
 * (e.g. 844×390) as desktop — the full IDE chrome leaves ~3 usable terminal
 * lines. A viewport is "mobile" when it is narrow (width ≤ 767) OR short-wide
 * (height < 500 while width > 767, i.e. a landscape phone; a landscape tablet
 * like 1024×768 keeps the desktop shell). Both queries subscribe live via
 * `matchMedia` so orientation flips re-render — no resize-event hacks.
 */

import { useEffect, useState } from 'react'
import { isTauriContext } from '@/lib/tauri-runtime'

/** Viewport max-width (px) for the mobile web shell. */
export const MOBILE_WEB_SHELL_MAX_PX = 767

/** Viewport max-height (px) for the landscape-phone shell rule (height < 500). */
export const MOBILE_WEB_SHELL_MAX_HEIGHT_PX = 499

const MOBILE_QUERY = `(max-width: ${MOBILE_WEB_SHELL_MAX_PX}px)`

/**
 * Landscape-phone query: shorter than 500px but wider than the 767 breakpoint.
 * `(min-width: 768px)` mirrors the width breakpoint's boundary so a viewport
 * can never satisfy both it and MOBILE_QUERY (no double-fire ambiguity).
 */
const SHORT_WIDE_QUERY = `(max-height: ${MOBILE_WEB_SHELL_MAX_HEIGHT_PX}px) and (min-width: ${
  MOBILE_WEB_SHELL_MAX_PX + 1
}px)`

/**
 * Pure helper for tests and non-React callers.
 * Returns false inside Tauri regardless of viewport.
 *
 * `matchesShortWide` (landscape phone: height < 500 while width > 767) is
 * optional and defaults to false, keeping the two-arg call sites and tests
 * from the pre-landscape contract valid.
 */
export function resolveMobileWebShell(
  isTauri: boolean,
  matchesNarrowViewport: boolean,
  matchesShortWide = false
): boolean {
  if (isTauri) return false
  return matchesNarrowViewport || matchesShortWide
}

/**
 * Subscribe to a media query with live updates. Returns the current match and
 * installs the change listener; the returned cleanup removes it. Uses the
 * modern `addEventListener` path, falling back to the deprecated `addListener`
 * alias so the shell still tracks orientation changes on the older mobile
 * browsers this hook targets.
 */
function subscribeMediaQuery(
  mql: MediaQueryList,
  onChange: (matches: boolean) => void
): () => void {
  const listener = (event?: MediaQueryListEvent): void => {
    onChange(event?.matches ?? mql.matches)
  }
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', listener)
    return () => mql.removeEventListener('change', listener)
  }
  if (typeof mql.addListener === 'function') {
    mql.addListener(listener)
    return () => mql.removeListener(listener)
  }
  return () => {}
}

/**
 * True when running in the browser (not Tauri) on a narrow or
 * landscape-phone-short viewport. Subscribes to `matchMedia` so orientation /
 * resize updates live.
 */
export function useMobileWebShell(): boolean {
  const [active, setActive] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return resolveMobileWebShell(
      isTauriContext(),
      window.matchMedia(MOBILE_QUERY).matches,
      window.matchMedia(SHORT_WIDE_QUERY).matches
    )
  })

  useEffect(() => {
    if (isTauriContext()) {
      setActive(false)
      return
    }

    if (typeof window.matchMedia !== 'function') return

    const narrowMql = window.matchMedia(MOBILE_QUERY)
    const shortWideMql = window.matchMedia(SHORT_WIDE_QUERY)

    const apply = (): void => {
      setActive(resolveMobileWebShell(false, narrowMql.matches, shortWideMql.matches))
    }
    apply()

    const cleanups = [
      subscribeMediaQuery(narrowMql, () => apply()),
      subscribeMediaQuery(shortWideMql, () => apply())
    ]
    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }, [])

  return active
}
