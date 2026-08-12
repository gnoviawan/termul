/**
 * Desktop-only capture-phase keydown blocker for devtools shortcuts.
 *
 * P5: only active in production (`import.meta.env.PROD`) — devs need F12 in
 * dev. The hook itself checks the env so the call site stays simple.
 *
 * P6: uses `e.code` (`'KeyI'`/`'KeyJ'`/`'KeyC'`/`'KeyU'`) instead of
 * `e.key` for locale-independent matching (Cyrillic etc. produce different
 * `e.key`). Accepts `ctrlKey || metaKey` (Cmd on macOS). Excludes `altKey`
 * so potential app shortcuts (Ctrl+Shift+Alt+I) are not swallowed. F12 keeps
 * `e.key === 'F12'` (its `e.code` is also `'F12'`).
 *
 * P10: emits a warn-level boundary log via `logFrontendError` on each block so
 * the suppression is auditable. Never throws.
 *
 * Desktop-only: mount ONLY in `TauriApp`. Web/remote (`App.tsx`) must never
 * call this hook — the browser cannot (and must not try to) block its own
 * devtools.
 */

import { useEffect } from 'react'
import { logFrontendError } from '@/lib/log-api'

/** True when the keydown event is a devtools/view-source shortcut to block. */
function isDevToolsShortcut(e: KeyboardEvent): boolean {
  // F12 — its e.code is also 'F12', so e.key check is fine.
  if (e.key === 'F12') return true

  // Ctrl/Cmd+Shift+I / J / C — devtools / console / inspect.
  // P6: use e.code for locale-independent matching; accept metaKey (macOS Cmd);
  // exclude altKey (avoid swallowing potential app shortcuts).
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
    if (e.code === 'KeyI' || e.code === 'KeyJ' || e.code === 'KeyC') return true
  }

  // Ctrl/Cmd+U — view source (same family of inspector shortcuts).
  // P6: accept metaKey (macOS Cmd+U); exclude altKey; use e.code.
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyU') {
    return true
  }

  return false
}

/**
 * Block devtools/view-source shortcuts at the capture phase on the desktop
 * surface. `preventDefault` + `stopPropagation` so the webview never opens the
 * inspector. P10: logs each block via `logFrontendError` (warn level) so the
 * suppression is auditable. No-op in dev (P5), outside a browser, or when not
 * in production.
 */
export function usePreventDevToolsShortcuts(): void {
  useEffect(() => {
    // P5: only block in production — devs need F12 / devtools in dev.
    if (!import.meta.env.PROD) return
    if (typeof document === 'undefined') return

    const handler = (e: KeyboardEvent): void => {
      if (!isDevToolsShortcut(e)) return
      e.preventDefault()
      e.stopPropagation()
      // P10: boundary log so the block is auditable (never throws).
      void logFrontendError({
        level: 'warn',
        message: `Blocked devtools shortcut: ${e.code || e.key}`,
        source: 'hooks/use-prevent-devtools-shortcuts'
      })
    }

    document.addEventListener('keydown', handler, { capture: true })
    return () => document.removeEventListener('keydown', handler, { capture: true })
  }, [])
}
