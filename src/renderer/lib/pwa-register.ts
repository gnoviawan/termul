/**
 * PWA service-worker registration facade (web client only).
 *
 * Called from the non-Tauri branch of `main.tsx` after the first render. All
 * capability checks live here so the bootstrap stays a one-line call and the
 * gates stay unit-testable:
 *
 * - Tauri desktop webview: returns early — no `/sw.js` request is ever made.
 * - Insecure context (`http://<LAN-IP>`): SW + install are a hard browser
 *   rule (https:// or localhost only), so skip.
 * - No `navigator.serviceWorker`: skip.
 * - Registration failure: `warn` — never thrown, never blocking app boot.
 *
 * Logging note: the backend `POST /log/frontend-error` endpoint is
 * loopback-gated, so it only accepts reports where the skip branches can
 * never fire (an insecure context is definitionally a non-loopback
 * `http://` origin — the POST would be refused). The two capability skips
 * therefore log locally via `console.info` (the diagnostic that is actually
 * visible where the skip happens); the `warn` registration-failure path
 * reports through `logFrontendError` (it lands on loopback-https deploys)
 * AND `console.warn` so it stays visible off-loopback too.
 *
 * Registration is deferred to `window load` (or run immediately when the
 * document is already complete) so the `/sw.js` fetch never competes with
 * first paint.
 */

import { logFrontendError } from './log-api'
import { isTauriContext } from './tauri-runtime'

/** Log source reported to the backend console channel for this module. */
const LOG_SOURCE = 'pwa-register'

/** Forward a registration failure to the backend log + local console. */
function reportRegistrationFailure(err: unknown): void {
  const message = `service worker registration failed: ${err instanceof Error ? err.message : String(err)}`
  console.warn(`[${LOG_SOURCE}] ${message}`)
  void logFrontendError({
    level: 'warn',
    source: LOG_SOURCE,
    message,
    stack: err instanceof Error ? err.stack : undefined
  })
}

/** Register `/sw.js`, forwarding any failure to the log channels. */
function doRegister(): void {
  // `register` can THROW synchronously (e.g. a browser policy refuses the
  // document) — the "never throws" contract covers sync failures too, not
  // just promise rejections.
  try {
    navigator.serviceWorker.register('/sw.js').catch(reportRegistrationFailure)
  } catch (err) {
    reportRegistrationFailure(err)
  }
}

/**
 * Attempt to register the PWA service worker. No-op outside a browser, inside
 * the Tauri desktop webview, on insecure contexts, or where service workers
 * are unsupported. Never throws — a failure here must never block app boot.
 */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined') {
    return
  }
  // Desktop runtime: the embedded webview must not register an SW (the web
  // bundle is also served from disk in dev, but the Tauri entry point is a
  // different document — this guard is belt-and-braces for any shared path).
  if (isTauriContext()) {
    return
  }
  // Secure context is a hard browser rule for SW + install (https:// or
  // localhost). A plain http:// LAN visit stays a normal tab — log locally
  // so the skip is diagnosable, not silent (see the module doc for why this
  // is console.info rather than the loopback-gated backend log).
  if (!window.isSecureContext) {
    console.info(
      `[${LOG_SOURCE}] service worker skipped: insecure context (install requires HTTPS or localhost)`
    )
    return
  }
  if (!('serviceWorker' in navigator)) {
    console.info(`[${LOG_SOURCE}] service worker skipped: navigator.serviceWorker unsupported`)
    return
  }

  // Defer to window load so the /sw.js request never competes with first
  // paint; if the document already finished loading, register immediately.
  if (document.readyState === 'complete') {
    doRegister()
  } else {
    window.addEventListener('load', doRegister, { once: true })
  }
}
