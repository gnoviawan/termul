/**
 * Frontend error logging facade (issue #244).
 *
 * Routes renderer errors to the backend log file via the `log_frontend_error`
 * Tauri command so they survive a closed production DevTools console. All
 * native access stays behind this facade per the project's adapter-boundary
 * rule; components and the ErrorBoundary import from here, never `invoke`
 * directly.
 */

import { invoke } from '@tauri-apps/api/core'

export interface FrontendErrorPayload {
  /** Severity routed to the backend logger. Defaults to 'error'. */
  level?: 'error' | 'warn'
  /** Human-readable error message. */
  message: string
  /** Origin label, e.g. 'window.onerror' or 'ErrorBoundary:Terminal Pane'. */
  source?: string
  /** JS error stack, when available. */
  stack?: string
  /** React component stack, for ErrorBoundary-caught errors. */
  componentStack?: string
}

/**
 * Forward a single renderer error to the backend log file.
 *
 * Never throws: a failure to log must not cascade into another error (which
 * could re-trigger the global handlers and loop).
 */
export async function logFrontendError(payload: FrontendErrorPayload): Promise<void> {
  try {
    await invoke('log_frontend_error', {
      level: payload.level ?? 'error',
      message: payload.message,
      source: payload.source ?? 'renderer',
      stack: payload.stack ?? null,
      componentStack: payload.componentStack ?? null
    })
  } catch {
    // Swallow — logging must be best-effort and side-effect free on failure.
  }
}

/** Normalize an unknown thrown value into a message + optional stack. */
function describeError(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack }
  }
  if (typeof value === 'string') {
    return { message: value }
  }
  try {
    return { message: JSON.stringify(value) }
  } catch {
    return { message: String(value) }
  }
}

let installed = false

/**
 * Install global `window.onerror` and `unhandledrejection` handlers that
 * forward to the backend log. Idempotent and a no-op outside a browser/webview
 * (no `window`). Call once, only in the Tauri runtime path.
 */
export function installGlobalErrorForwarding(): void {
  if (installed || typeof window === 'undefined') {
    return
  }
  installed = true

  window.addEventListener('error', (event: ErrorEvent) => {
    // Resource-load failures (<img>/<script>/CSS) surface here with no `error`
    // object and often an empty `message`. They are not JS exceptions and add
    // only noise, so skip them — forward only real errors.
    if (!event.error && !event.message) {
      return
    }
    const described = describeError(event.error ?? event.message)
    void logFrontendError({
      source: 'window.onerror',
      message: described.message,
      stack: described.stack
    })
  })

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const described = describeError(event.reason)
    void logFrontendError({
      source: 'unhandledrejection',
      message: described.message,
      stack: described.stack
    })
  })
}
