import { toast } from 'sonner'
import { clipboardApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'

/**
 * Copy text to the clipboard reliably across the Tauri webview.
 *
 * The Tauri clipboard plugin returns an `IpcResult` (it signals failure via
 * `success: false` rather than throwing), so callers must inspect the result —
 * a plain `.then()` would falsely report success. We try the plugin first, then
 * fall back to the async Clipboard API, then to a legacy `execCommand` copy.
 *
 * @returns true when the text was placed on the clipboard.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false

  // 1) Tauri clipboard plugin — most reliable inside the webview.
  try {
    const res = await clipboardApi.writeText(text)
    if (res.success) return true
  } catch {
    // fall through to the next strategy
  }

  // 2) Async Clipboard API (works in secure contexts on a user gesture).
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the next strategy
  }

  // 3) Legacy hidden-textarea + execCommand fallback.
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

export interface CopyToast {
  title: string
  description?: string
  failureTitle: string
  /** `logFrontendError` source of the failure line. */
  logSource: string
}

/**
 * `copyText` with the outcome toasted, and one warn log when it fails. The log
 * never carries the copied text: it can hold a chat title or a path.
 */
export async function copyTextWithToast(text: string, notice: CopyToast): Promise<boolean> {
  const copied = await copyText(text)
  if (copied) {
    toast.success(notice.title, { description: notice.description })
    return true
  }
  toast.error(notice.failureTitle, { description: 'Could not copy to clipboard' })
  void logFrontendError({
    level: 'warn',
    source: notice.logSource,
    message: `${notice.failureTitle}: every clipboard strategy failed`
  })
  return false
}
