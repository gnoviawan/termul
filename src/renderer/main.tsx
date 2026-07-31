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
import { preloadCommonLanguages } from './hooks/use-codemirror'
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

// Prime CodeMirror language caches (js/ts/json) so the first open of these
// common file types doesn't pay the dynamic-import latency. Fire-and-forget;
// runs in parallel with React bootstrap (issue #378). Does not pull Tauri.
preloadCommonLanguages()

if (isTauriContext()) {
  // Forward uncaught renderer errors + unhandled rejections to the backend log
  // file so production crashes are diagnosable (issue #244). Tauri-only: the
  // browser/web path has no backend command to call.
  installGlobalErrorForwarding()
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
