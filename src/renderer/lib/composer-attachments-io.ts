/**
 * Browser-safe composer attachment IO (Story 1.6).
 *
 * Keeps `@tauri-apps` filesystem/clipboard/dialog/path calls out of the chat
 * component layer. Desktop uses Tauri plugins; web uses DOM File / input /
 * ClipboardEvent (no temp-file path required for inline image blocks).
 */
import { join, tempDir } from '@tauri-apps/api/path'
import { readImage } from '@tauri-apps/plugin-clipboard-manager'
import { open } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'
import { runtimeT } from '@/i18n/runtime'
import { isTauriContext } from '@/lib/tauri-runtime'
import { randomUUID } from '@/lib/uuid'

export async function writeBytesToTempFile(bytes: Uint8Array, fileName: string): Promise<string> {
  if (!isTauriContext()) {
    throw new Error(
      runtimeT(
        'chat',
        'attachments.errors.tempWriteDesktopOnly',
        'Temp file write is desktop-only; use inline File bytes on web'
      )
    )
  }
  const safe = (fileName || 'pasted-image.png').replace(/[^\w.-]+/g, '_')
  const dir = await tempDir()
  const path = await join(dir, `faizui-${randomUUID()}-${safe}`)
  await writeFile(path, bytes)
  return path
}

export async function pickAttachmentPaths(): Promise<string[] | null> {
  if (!isTauriContext()) {
    return pickAttachmentPathsBrowser()
  }
  const selected = await open({
    multiple: true,
    title: runtimeT('chat', 'composer.attachFiles', 'Attach files')
  })
  if (selected == null) return null
  return Array.isArray(selected) ? selected : [selected]
}

function pickAttachmentPathsBrowser(): Promise<string[] | null> {
  // Web MVP: no filesystem paths — return null so the caller can use a
  // hidden <input type=file> / drag-drop File channel instead.
  return Promise.resolve(null)
}

/** Pick files in the browser via a transient file input (no path strings). */
export function pickAttachmentFilesBrowser(): Promise<File[] | null> {
  return new Promise((resolve) => {
    let settled = false
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    const cleanup = () => {
      input.remove()
      window.removeEventListener('focus', onWindowFocus)
    }
    const finish = (value: File[] | null) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    // Some browsers never fire `cancel`; when the dialog closes focus returns.
    const onWindowFocus = () => {
      window.setTimeout(() => {
        if (!settled) finish(null)
      }, 300)
    }
    input.addEventListener('change', () => {
      const files = input.files ? Array.from(input.files) : []
      finish(files.length > 0 ? files : null)
    })
    input.addEventListener('cancel', () => {
      finish(null)
    })
    document.body.appendChild(input)
    window.addEventListener('focus', onWindowFocus)
    input.click()
  })
}

export interface ClipboardRgbaImage {
  rgba: Uint8Array
  width: number
  height: number
}

/** Read an OS clipboard image (Tauri). Returns null when unavailable. */
export async function readClipboardRgbaImage(): Promise<ClipboardRgbaImage | null> {
  if (!isTauriContext()) return null
  try {
    const image = await readImage()
    const rgba = await image.rgba()
    const size = await image.size()
    return { rgba, width: size.width, height: size.height }
  } catch {
    return null
  }
}
