/**
 * APP BOOTSTRAP ENTRY POINT
 * =========================
 *
 * This is the generic renderer entry point for Termul Manager.
 * The desktop runtime is Tauri-first, while this file remains useful for
 * browser-based development, preview, the web client (`build:web`), and tests.
 *
 * Bootstrap Strategy:
 * ------------------
 * 1. Tauri Runtime (Primary): Dynamic-imports TauriApp only when
 *    `isTauriContext()` is true, so the web entry path never evaluates the
 *    TauriApp module (and its `@tauri-apps/api/window` edge).
 *    - Desktop production entry remains: tauri-index.html -> tauri-main.tsx
 *      (static TauriApp import — unchanged).
 *
 * 2. Browser / web client: Renders App synchronously when not in Tauri.
 *    Real `@tauri-apps/*` packages are aliased to stubs in `vite.config.web.ts`
 *    so the App import graph does not ship native IPC code in `dist-web/`.
 *
 * Context Detection:
 * -----------------
 * Uses canonical `isTauriContext()` from `@/lib/tauri-runtime` (detects
 * `window.__TAURI_INTERNALS__`). Do not duplicate the detector here.
 *
 * NO SILENT FALLBACKS:
 * -------------------
 * - Tauri APIs are protected by explicit isTauriContext() guards
 * - Each runtime path is deliberately chosen, not accidentally discovered
 */

import { createRoot } from 'react-dom/client'
import { isTauriContext } from '@/lib/tauri-runtime'
import App from './App'
import { installGlobalErrorForwarding } from './lib/log-api'
import './index.css'
// Streamdown streaming animation keyframes (sd-fadeIn / sd-blurIn / sd-slideUp),
// used by AgentProse's `animated` word-by-word reveal.
import 'streamdown/styles.css'

/**
 * Bootstrap the appropriate app component based on runtime context
 *
 * - Tauri context: dynamic-import TauriApp (desktop shell + window APIs)
 * - Browser/web context: render App without ever loading TauriApp
 */
const root = createRoot(document.getElementById('root')!)

// Forward uncaught renderer errors + unhandled rejections to the backend log
// file so production crashes are diagnosable (issue #244). Runs in BOTH modes:
// - Tauri: invokes the `log_frontend_error` command (desktop log file).
// - Web: POSTs to `/log/frontend-error` (the web branch in `logFrontendError`
//   was added in Phase 2.3; the server reuses the same sanitization + tracing).
// `installGlobalErrorForwarding` is idempotent and a no-op outside a browser.
installGlobalErrorForwarding()

if (isTauriContext()) {
  void import('./TauriApp')
    .then(({ default: TauriApp }) => {
      root.render(<TauriApp />)
    })
    .catch((err) => {
      console.error('Failed to load TauriApp; falling back to App', err)
      root.render(<App />)
    })
} else {
  root.render(<App />)
}

// Prime CodeMirror language caches (js/ts/json) so the first open of these
// common file types doesn't pay the dynamic-import latency. Fire-and-forget;
// deferred until after first paint + browser idle (requestIdleCallback, with a
// setTimeout fallback for browsers without it) so it never competes with first
// contentful paint (issue #378). Dynamic import keeps CodeMirror core out of the
// entry chunk's critical path.
const runIdle = (fn: () => void): void => {
  const fallback = window.setTimeout
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(fn, { timeout: 2000 })
  } else {
    fallback(fn, 1_000)
  }
}
runIdle(() => {
  void import('./hooks/use-codemirror').then((m) => m.preloadCommonLanguages())
})
