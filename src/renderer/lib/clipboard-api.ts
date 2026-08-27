/**
 * Clipboard API Singleton
 *
 * Exports a singleton instance of the ClipboardApi for use throughout the app.
 * This provides a consistent interface whether running under Electron or Tauri.
 *
 * Usage:
 *   import { clipboardApi } from '@/lib/clipboard-api'
 *   const result = await clipboardApi.readText()
 */

import type { ClipboardApi } from '@shared/types/ipc.types'
import { logFrontendError } from './log-api'
import { tauriClipboardApi } from './tauri-clipboard-api'
import { isTauriContext } from './tauri-runtime'

/**
 * CAP-2 / GH-588: non-secure-context clipboard fallback.
 *
 * `navigator.clipboard.readText()/writeText()` are only available in secure
 * contexts (HTTPS or localhost). The shared `dist-web` bundle is served by
 * `termul-server` over plain HTTP on a bare IP, where `navigator.clipboard` is
 * `undefined` — the browser path threw on every Ctrl+V, so terminal paste
 * broke. The browser path here keeps the native Async Clipboard API as the
 * primary path and falls back to:
 *  - readText: a document-level `paste`-event capture into a buffer (plus a
 *    one-shot wait when the buffer is empty, so a just-pressed paste resolves).
 *  - writeText: a hidden textarea + `execCommand('copy')` (the legacy
 *    synchronous copy that works in non-secure contexts).
 *
 * The fallback never throws; a failure to read/write maps to `READ_ERROR` /
 * `WRITE_ERROR` and logs once via `logFrontendError` so the degradation is
 * observable. The desktop `tauriClipboardApi` path is untouched.
 */

let pasteBuffer: string | null = null
let pasteListenerInstalled = false
let warnedClipboardFallback = false
// F3: a QUEUE of pending readText waiters (not a single slot) so a concurrent
// readText() no longer overwrites (and strands) a prior waiter. Each entry
// carries its own timeout so an individual waiter can time out independently.
let pendingPasteResolvers: PendingResolver[] = []

/** One-shot wait timeout for a paste event when the buffer is empty. */
const PASTE_FALLBACK_TIMEOUT_MS = 5000

type FallbackReadResult =
  | { success: true; data: string }
  | { success: false; error: string; code: string }

interface PendingResolver {
  resolve: (result: FallbackReadResult) => void
  timer: ReturnType<typeof setTimeout>
}

function warnClipboardFallbackOnce(): void {
  if (warnedClipboardFallback) return
  warnedClipboardFallback = true
  void logFrontendError({
    level: 'warn',
    message:
      'navigator.clipboard unavailable (non-secure context); using paste-event + textarea fallback',
    source: 'lib/clipboard-api'
  })
}

/**
 * The document-level `paste` capture handler. Stable module-level reference so
 * `addEventListener` dedupes re-registration (F9: the install flag may be reset
 * for hermetic tests without registering duplicate listeners).
 *
 * Caches the latest paste into `pasteBuffer` and, when one or more `readText()`
 * waiters are queued, drains ALL of them (F3: concurrency-safe) with the text
 * and clears their timers. F4: after draining, clears `pasteBuffer` so a later
 * `readText()` doesn't return this paste as stale buffered data.
 */
function onPasteCapture(event: ClipboardEvent): void {
  const cd = event.clipboardData
  if (!cd) return // no clipboard data on the event — nothing to capture
  // A valid paste may carry empty text (e.g. an empty clipboard). Distinguish
  // that from a missing clipboardData so an empty paste still resolves
  // pending readText() waiters (CodeRabbit: don't reject empty text).
  const text = cd.getData('text/plain') ?? ''
  pasteBuffer = text
  if (pendingPasteResolvers.length > 0) {
    const resolvers = pendingPasteResolvers
    pendingPasteResolvers = []
    for (const p of resolvers) {
      clearTimeout(p.timer)
      p.resolve({ success: true, data: text })
    }
    // F4: the waiters consumed this paste directly; don't leave it buffered.
    pasteBuffer = null
  }
}

/**
 * Lazily install the capture-phase `paste` listener on `document`. Never calls
 * `preventDefault()` so it does not interfere with the app's own paste
 * handling (the terminal's Ctrl+V remains owned by xterm's key handler).
 */
function installPasteCaptureListener(): void {
  if (pasteListenerInstalled || typeof document === 'undefined') return
  pasteListenerInstalled = true
  document.addEventListener('paste', onPasteCapture, true)
}

/**
 * Read clipboard text via the non-secure-context fallback. Returns buffered
 * paste text (and clears the buffer — F4) when available; otherwise queues a
 * one-shot waiter that resolves on the next paste event or times out to
 * `READ_ERROR` so callers never hang indefinitely.
 */
function readTextFromFallback(): Promise<FallbackReadResult> {
  installPasteCaptureListener()
  if (pasteBuffer !== null) {
    // F4: clear after consumption so a later readText doesn't get a stale paste.
    const data = pasteBuffer
    pasteBuffer = null
    return Promise.resolve({ success: true, data })
  }
  return new Promise<FallbackReadResult>((resolve) => {
    const timer = setTimeout(() => {
      // F3: remove only THIS waiter; concurrent waiters are unaffected.
      const idx = pendingPasteResolvers.findIndex((p) => p.resolve === resolve)
      if (idx >= 0) {
        pendingPasteResolvers.splice(idx, 1)
      }
      resolve({
        success: false,
        error: 'clipboard read timed out (non-secure context fallback)',
        code: 'READ_ERROR'
      })
    }, PASTE_FALLBACK_TIMEOUT_MS)
    pendingPasteResolvers.push({ resolve, timer })
  })
}

/**
 * Reset the fallback module state. Exported for unit tests so the paste
 * buffer / pending waiters / warn-once guard / install flag are deterministic
 * across isolated cases. `onPasteCapture` is a stable reference, so resetting
 * the flag and re-registering on the next readText is safe (addEventListener
 * dedupes the duplicate).
 */
export function __resetClipboardFallbackForTesting(): void {
  pasteBuffer = null
  for (const p of pendingPasteResolvers) {
    clearTimeout(p.timer)
  }
  pendingPasteResolvers = []
  warnedClipboardFallback = false
  pasteListenerInstalled = false
}

/** Lazily create an off-screen textarea used by the writeText fallback. */
function getHiddenTextarea(): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null
  let ta = document.getElementById('termul-clipboard-fallback') as HTMLTextAreaElement | null
  if (!ta) {
    ta = document.createElement('textarea')
    ta.id = 'termul-clipboard-fallback'
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.width = '1px'
    ta.style.height = '1px'
    ta.style.padding = '0'
    ta.style.border = 'none'
    ta.style.outline = 'none'
    ta.style.boxShadow = 'none'
    ta.style.background = 'transparent'
    ta.setAttribute('aria-hidden', 'true')
    ta.tabIndex = -1
    document.body.appendChild(ta)
  }
  return ta
}

/**
 * Write clipboard text via the non-secure-context fallback: a hidden textarea
 * + `document.execCommand('copy')`. `execCommand` is deprecated but remains
 * the only synchronous copy path available in plain-HTTP contexts where the
 * Async Clipboard API is gated. Returns `WRITE_ERROR` on failure.
 */
function writeTextFromFallback(
  text: string
): { success: true; data: undefined } | { success: false; error: string; code: string } {
  const ta = getHiddenTextarea()
  if (!ta) {
    return { success: false, error: 'no document for clipboard fallback', code: 'WRITE_ERROR' }
  }
  const prevActive = document.activeElement as HTMLElement | null
  ta.value = text
  ta.focus()
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  prevActive?.focus?.()
  if (!ok) {
    return {
      success: false,
      error: 'execCommand(copy) failed (non-secure context fallback)',
      code: 'WRITE_ERROR'
    }
  }
  return { success: true, data: undefined }
}

/**
 * Singleton ClipboardApi instance
 *
 * Uses Tauri IPC implementation when running in Tauri context.
 * In the future, this could conditionally export an Electron implementation
 * based on build environment.
 */
const browserClipboardApi: ClipboardApi = {
  async readText() {
    const hasAsyncClipboard =
      typeof navigator !== 'undefined' && typeof navigator.clipboard !== 'undefined'
    if (hasAsyncClipboard) {
      try {
        return { success: true, data: await navigator.clipboard.readText() }
      } catch (error) {
        // F16: a SECURE-context readText() rejection is permission-denied /
        // NotAllowedError / SecurityError — NOT "a paste event is coming". Return
        // READ_ERROR directly. Do NOT call readTextFromFallback (it would hang
        // 5s waiting for a paste event that will never fire) and do NOT call
        // warnClipboardFallbackOnce (its message misdiagnoses a secure-context
        // permission failure as a non-secure-context degradation).
        return { success: false, error: String(error), code: 'READ_ERROR' }
      }
    }
    warnClipboardFallbackOnce()
    return readTextFromFallback()
  },
  async writeText(text) {
    const hasAsyncClipboard =
      typeof navigator !== 'undefined' && typeof navigator.clipboard !== 'undefined'
    if (hasAsyncClipboard) {
      try {
        await navigator.clipboard.writeText(text)
        return { success: true, data: undefined }
      } catch (error) {
        warnClipboardFallbackOnce()
        const fallback = writeTextFromFallback(text)
        if (fallback.success) return fallback
        return { success: false, error: String(error), code: 'WRITE_ERROR' }
      }
    }
    warnClipboardFallbackOnce()
    return writeTextFromFallback(text)
  },
  async hasImage() {
    return { success: true, data: false }
  }
}

export const clipboardApi: ClipboardApi = isTauriContext() ? tauriClipboardApi : browserClipboardApi
