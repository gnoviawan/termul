/**
 * Frontend error logging facade (issue #244).
 *
 * Routes renderer errors to the backend log file so they survive a closed
 * production DevTools console. In the Tauri runtime this calls the
 * `log_frontend_error` command; in web/remote mode (`!isTauriContext()`) it
 * POSTs to the termul-server `/log/frontend-error` route (CAP-2 parity), which
 * writes the same sanitized line via `tracing`. All native access stays behind
 * this facade per the project's adapter-boundary rule; components and the
 * ErrorBoundary import from here, never `invoke` directly.
 */

import { invoke } from '@tauri-apps/api/core'

import { isTauriContext } from './tauri-runtime'
import { webServerLog } from './web-server-api'

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
 * Branches on `isTauriContext()`: the desktop path invokes the Tauri command;
 * the web path POSTs to `/log/frontend-error` (the server reuses the same
 * sanitization + tracing the desktop command uses). Never throws: a failure to
 * log must not cascade into another error (which could re-trigger the global
 * handlers and loop).
 */
export async function logFrontendError(payload: FrontendErrorPayload): Promise<void> {
  try {
    if (isTauriContext()) {
      await invoke('log_frontend_error', {
        level: payload.level ?? 'error',
        message: payload.message,
        source: payload.source ?? 'renderer',
        stack: payload.stack ?? null,
        componentStack: payload.componentStack ?? null
      })
    } else {
      await webServerLog.frontendError({
        level: payload.level ?? 'error',
        message: payload.message,
        source: payload.source ?? 'renderer',
        stack: payload.stack,
        componentStack: payload.componentStack
      })
    }
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
 * (no `window`). Works in both the Tauri runtime and web/remote mode —
 * `logFrontendError` branches on `isTauriContext()` so errors survive a closed
 * DevTools in either surface. Call once during app bootstrap (both `TauriApp`
 * and `App` entries).
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

export async function revealLogDir(): Promise<void> {
  try {
    await invoke('reveal_log_dir_command')
  } catch (error) {
    console.error('Failed to reveal log directory:', error)
  }
}

export async function exportLogFile(): Promise<void> {
  try {
    await invoke('export_log_file_command')
  } catch (error) {
    console.error('Failed to export log file:', error)
  }
}

export async function copyLogContents(): Promise<void> {
  try {
    await invoke('copy_log_contents_command')
  } catch (error) {
    console.error('Failed to copy log contents:', error)
  }
}

export async function exportLogToDefault(): Promise<void> {
  try {
    await invoke('export_log_to_default_command')
  } catch (error) {
    console.error('Failed to export log to default:', error)
  }
}
