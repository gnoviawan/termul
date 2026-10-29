/**
 * Per-attachment "copy image" for the Report a Bug dialog
 * (spec-bug-report-dialog).
 *
 * Screenshots stay client-side — the report flow never uploads images —
 * so the user's path into the filed GitHub issue is: copy each staged
 * image to the OS clipboard, then paste it into the issue editor.
 *
 * Two write channels cover the surfaces:
 *
 * - Desktop (Tauri): `clipboard-manager:allow-write-image` — the plugin
 *   accepts encoded PNG bytes.
 * - Web/remote + fallback: `navigator.clipboard.write` with a PNG
 *   `ClipboardItem` (the only image type every browser accepts).
 *
 * Source bytes come from the `PendingAttachment`: inline `base64` for
 * pasted/browser images, `readMediaBytes` for OS-picker `file-ref`
 * paths. Non-PNG payloads round-trip through a canvas once so both
 * channels always receive `image/png`.
 */

import { writeClipboardImagePng } from '@/lib/composer-attachments-io'
import { logFrontendError } from '@/lib/log-api'
import { readMediaBytes } from '@/lib/media-bytes-api'
import { isTauriContext } from '@/lib/tauri-runtime'
import type { PendingAttachment } from '../chat/chat-attachments'

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Resolve the encoded image bytes for an image-like attachment. */
async function attachmentImageBytes(att: PendingAttachment): Promise<Uint8Array> {
  if (att.kind === 'image') {
    return base64ToBytes(att.base64)
  }
  if (att.kind === 'file-ref') {
    const result = await readMediaBytes(att.path)
    if (!result.success) throw new Error(result.error)
    return new Uint8Array(await result.data.arrayBuffer())
  }
  throw new Error('Only image attachments can be copied')
}

/** The PNG magic header — bytes trump the declared mime, which can lie. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function isPngBytes(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_MAGIC.length && PNG_MAGIC.every((byte, i) => bytes[i] === byte)
}

/**
 * Re-encode to PNG through a canvas so clipboard channels (which accept
 * only PNG reliably) always get a supported type. The magic bytes are
 * sniffed instead of trusting `mimeType` — a mislabeled `image/png` (e.g.
 * JPEG bytes under a `.png` name) must re-encode or it lands on the
 * clipboard as an undecodable "PNG". A canvas that cannot be created
 * (jsdom, exotic codecs) throws — the caller surfaces the error.
 */
async function ensurePngBytes(bytes: Uint8Array, mimeType: string): Promise<Uint8Array> {
  if (isPngBytes(bytes)) return bytes
  const objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }))
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Could not decode image for clipboard copy'))
      el.src = objectUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable for image re-encode')
    ctx.drawImage(image, 0, 0)
    const dataUrl = canvas.toDataURL('image/png')
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    if (!base64) throw new Error('Image re-encode produced no data')
    return base64ToBytes(base64)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function logCopyFailure(message: string): void {
  // Boundary log only: the image bytes never appear in the log.
  void logFrontendError({ level: 'warn', source: 'bug-report.copyImage', message })
}

/**
 * Copy a staged screenshot to the OS clipboard as PNG. Desktop tries the
 * Tauri clipboard plugin first and falls back to the Async Clipboard API
 * (inside the webview it still needs a user gesture — the copy button is
 * one). Throws when no channel lands the image.
 */
export async function copyAttachmentImage(att: PendingAttachment): Promise<void> {
  let png: Uint8Array
  try {
    const bytes = await attachmentImageBytes(att)
    png = await ensurePngBytes(bytes, att.mimeType)
  } catch (error) {
    logCopyFailure(error instanceof Error ? error.message : String(error))
    throw error instanceof Error ? error : new Error(String(error))
  }

  if (isTauriContext()) {
    try {
      await writeClipboardImagePng(png)
      return
    } catch {
      // Fall through to the Async Clipboard API — on platforms where the
      // plugin's writeImage is unsupported the webview channel may work.
    }
  }

  if (typeof ClipboardItem === 'function' && navigator.clipboard?.write) {
    try {
      const blob = new Blob([png as BlobPart], { type: 'image/png' })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return
    } catch (error) {
      logCopyFailure(
        `navigator.clipboard.write failed: ${error instanceof Error ? error.message : String(error)}`
      )
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  const error = new Error('No image clipboard channel is available')
  logCopyFailure(error.message)
  throw error
}
