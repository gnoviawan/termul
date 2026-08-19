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
import { bootstrapI18n } from '@/i18n/bootstrap'
import { isTauriContext } from '@/lib/tauri-runtime'
import App from './App'
import { installGlobalErrorForwarding } from './lib/log-api'
import './index.css'
// Streamdown streaming animation keyframes (sd-fadeIn / sd-blurIn / sd-slideUp),
// used by AgentProse's `animated` word-by-word reveal.
import 'streamdown/styles.css'

// Forward uncaught renderer errors + unhandled rejections to the backend log
// file so production crashes are diagnosable (issue #244). Runs in BOTH modes.
installGlobalErrorForwarding()

// Prime CodeMirror language caches after first paint so the entry path stays fast.
const runIdle = (fn: () => void): void => {
  const fallback = window.setTimeout
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(fn, { timeout: 2000 })
  } else {
    fallback(fn, 1_000)
  }
}

/**
 * Initialize the selected language before rendering either runtime root, then
 * preserve the existing Tauri-safe dynamic import boundary.
 */
async function bootstrap(): Promise<void> {
  await bootstrapI18n()
  const root = createRoot(document.getElementById('root')!)

  if (isTauriContext()) {
    try {
      const { default: TauriApp } = await import('./TauriApp')
      root.render(<TauriApp />)
    } catch (err) {
      console.error('Failed to load TauriApp; falling back to App', err)
      root.render(<App />)
    }
  } else {
    root.render(<App />)
  }

  runIdle(() => {
    void import('./hooks/use-codemirror').then((m) => m.preloadCommonLanguages())
  })
}

void bootstrap()
