import { clipboardApi } from '@/lib/api'

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
