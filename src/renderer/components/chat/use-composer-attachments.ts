import { join, tempDir } from '@tauri-apps/api/path'
import { readImage } from '@tauri-apps/plugin-clipboard-manager'
import { open } from '@tauri-apps/plugin-dialog'
import { readFile, writeFile } from '@tauri-apps/plugin-fs'
import { type ClipboardEvent, useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  basename,
  guessMimeType,
  isImageMime,
  isTextLike,
  MAX_EMBED_BYTES,
  MAX_IMAGE_BYTES,
  type PendingAttachment,
  uint8ToBase64
} from './chat-attachments'

function attachmentId(): string {
  return `att-${crypto.randomUUID()}`
}

/** Read a browser image File into an inline base64 `image` attachment. */
function readImageAsAttachment(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      const comma = dataUrl.indexOf(',')
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : ''
      if (!base64) {
        reject(new Error('Failed to read image'))
        return
      }
      resolve({
        kind: 'image',
        id: attachmentId(),
        name: file.name || 'image',
        mimeType: file.type || 'image/png',
        previewUrl: dataUrl,
        base64
      })
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'))
    reader.readAsDataURL(file)
  })
}

/** Read a browser text File into an inline embedded-resource attachment. */
function readTextAsAttachment(file: File): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      resolve({
        kind: 'file-embed',
        id: attachmentId(),
        name: file.name || 'file',
        mimeType: file.type || guessMimeType(file.name),
        text: String(reader.result ?? ''),
        size: file.size
      })
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsText(file)
  })
}

/** Read an image file by path into an inline base64 `image` attachment. */
async function readImagePathAsAttachment(
  path: string,
  name: string,
  mimeType: string
): Promise<PendingAttachment> {
  const bytes = await readFile(path)
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Image too large')
  const base64 = uint8ToBase64(bytes)
  return {
    kind: 'image',
    id: attachmentId(),
    name,
    mimeType,
    previewUrl: `data:${mimeType};base64,${base64}`,
    base64
  }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Persist image bytes to a temp file and attach them as a path `resource_link`.
 * Used when the agent can read files by path but does NOT accept inline image
 * blocks (no `image` prompt capability) — e.g. pasting a screenshot for an
 * agent that opens the file with its own Read tool.
 */
async function writeImageBytesToTempLink(
  bytes: Uint8Array,
  name: string,
  mimeType: string
): Promise<PendingAttachment> {
  const safe = (name || 'pasted-image.png').replace(/[^\w.-]+/g, '_')
  const dir = await tempDir()
  const path = await join(dir, `faizui-${crypto.randomUUID()}-${safe}`)
  await writeFile(path, bytes)
  const previewUrl = isImageMime(mimeType)
    ? `data:${mimeType};base64,${uint8ToBase64(bytes)}`
    : undefined
  return { kind: 'file-ref', id: attachmentId(), name: name || safe, mimeType, path, previewUrl }
}

/** Read a browser image File's bytes into a temp-file `resource_link`. */
async function fileToTempLink(file: File): Promise<PendingAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return writeImageBytesToTempLink(bytes, file.name || 'image.png', file.type || 'image/png')
}

/**
 * Decode the OS clipboard image (e.g. a Windows screenshot) into a PNG
 * attachment. The Tauri clipboard returns raw RGBA, so re-encode via a canvas.
 * Returns null when the clipboard holds no usable image.
 */
async function readClipboardImageAttachment(): Promise<Extract<
  PendingAttachment,
  { kind: 'image' }
> | null> {
  let rgba: Uint8Array
  let width: number
  let height: number
  try {
    const image = await readImage()
    rgba = await image.rgba()
    const size = await image.size()
    width = size.width
    height = size.height
  } catch {
    return null
  }
  if (rgba.length === 0 || width === 0 || height === 0) return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0)
  const dataUrl = canvas.toDataURL('image/png')
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  if (!base64) return null
  return {
    kind: 'image',
    id: attachmentId(),
    name: 'pasted-image.png',
    mimeType: 'image/png',
    previewUrl: dataUrl,
    base64
  }
}

/**
 * Collect File objects from a clipboard/drag payload, covering BOTH `files` and
 * `items` (screenshots often surface only as an image item, not in `files`),
 * de-duplicating the overlap.
 */
function dataTransferFiles(data: DataTransfer): File[] {
  const fromItems = Array.from(data.items)
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter((f): f is File => f != null)
  const all = [...Array.from(data.files), ...fromItems]
  const seen = new Set<string>()
  return all.filter((f) => {
    const key = `${f.name}:${f.size}:${f.type}:${f.lastModified}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export interface ComposerAttachments {
  attachments: PendingAttachment[]
  /** Browser channel (drag/paste): File objects with no path. */
  addFiles: (files: FileList | File[]) => Promise<void>
  /** Picker channel (OS file dialog): real filesystem paths. */
  pickFiles: () => Promise<void>
  /** Paste handler for a composer textarea — images from clipboard, incl. screenshots. */
  handlePaste: (e: ClipboardEvent<HTMLElement>) => void
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  /** Whether the OS picker affordance should be shown (resource_link, always supported). */
  canPick: boolean
  /** Whether drag/paste can produce an accepted block for this agent. */
  canDropPaste: boolean
}

/**
 * Shared composer attachment engine for the Agent Chat input and the new-thread
 * launcher. Encodes the hybrid transport from
 * docs/adr/0001-agent-chat-file-attachment-transport.md: OS picker -> path
 * `resource_link` (images read inline when capable); drag/paste -> inline
 * base64 image or embedded text resource, gated by capability.
 */
export function useComposerAttachments(opts: {
  imageCapable: boolean
  embedCapable: boolean
  disabled: boolean
}): ComposerAttachments {
  const { imageCapable, embedCapable, disabled } = opts
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files)
      if (arr.length === 0) return
      const reads: Promise<PendingAttachment>[] = []
      let tooLarge = 0
      let needEmbed = 0
      let unsupported = 0
      for (const f of arr) {
        if (isImageMime(f.type)) {
          // Images always attach: inline base64 when the agent accepts images,
          // otherwise a temp-file resource_link the agent can read by path.
          if (f.size > MAX_IMAGE_BYTES) tooLarge++
          else if (imageCapable) reads.push(readImageAsAttachment(f))
          else reads.push(fileToTempLink(f))
        } else if (isTextLike(f.name, f.type)) {
          if (!embedCapable) needEmbed++
          else if (f.size > MAX_EMBED_BYTES) tooLarge++
          else reads.push(readTextAsAttachment(f))
        } else {
          unsupported++
        }
      }
      if (reads.length > 0) {
        try {
          const read = await Promise.all(reads)
          setAttachments((prev) => [...prev, ...read])
        } catch {
          toast.error('Failed to read attachment')
        }
      }
      if (tooLarge > 0) toast.error('File too large')
      if (needEmbed > 0)
        toast.error("This agent can't embed files — use the attach button to link by path")
      if (unsupported > 0) toast.error('Unsupported file type (text or image only)')
    },
    [imageCapable, embedCapable]
  )

  const pickFiles = useCallback(async () => {
    if (disabled) return
    let selected: string | string[] | null
    try {
      selected = await open({ multiple: true, title: 'Attach files' })
    } catch {
      toast.error('Failed to open file picker')
      return
    }
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    const next: PendingAttachment[] = []
    let unsupported = 0
    let readFell = 0
    for (const path of paths) {
      const name = basename(path)
      const mimeType = guessMimeType(name)
      if (isImageMime(mimeType)) {
        if (imageCapable) {
          try {
            next.push(await readImagePathAsAttachment(path, name, mimeType))
          } catch {
            readFell++
            next.push({ kind: 'file-ref', id: attachmentId(), name, mimeType, path })
          }
        } else {
          // Link the path, but read the bytes for a thumbnail preview.
          let previewUrl: string | undefined
          try {
            const bytes = await readFile(path)
            if (bytes.byteLength <= MAX_IMAGE_BYTES) {
              previewUrl = `data:${mimeType};base64,${uint8ToBase64(bytes)}`
            }
          } catch {
            // No preview; the card falls back to a file icon.
          }
          next.push({ kind: 'file-ref', id: attachmentId(), name, mimeType, path, previewUrl })
        }
      } else if (isTextLike(name)) {
        next.push({ kind: 'file-ref', id: attachmentId(), name, mimeType, path })
      } else {
        unsupported++
      }
    }
    if (next.length > 0) setAttachments((prev) => [...prev, ...next])
    if (readFell > 0) toast.error('Could not read image inline — linked by path instead')
    if (unsupported > 0) toast.error('Unsupported file type (text or image only)')
  }, [disabled, imageCapable])

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLElement>) => {
      if (disabled) return
      const data = e.clipboardData
      const files = dataTransferFiles(data)
      if (files.length > 0) {
        // addFiles surfaces capability/size errors via toast.
        e.preventDefault()
        void addFiles(files)
        return
      }
      // No DOM file. If there is text on the clipboard, let the normal paste run.
      if (data.getData('text') !== '') return
      // Likely an OS bitmap the webview doesn't expose to the DOM (e.g. a
      // Windows screenshot). Fall back to the Tauri clipboard for an image.
      e.preventDefault()
      void (async () => {
        const att = await readClipboardImageAttachment()
        if (!att) return // empty/non-image clipboard — nothing to do
        if ((att.base64.length * 3) / 4 > MAX_IMAGE_BYTES) {
          toast.error('Image too large (max 10 MB)')
          return
        }
        if (imageCapable) {
          setAttachments((prev) => [...prev, att])
          return
        }
        // Agent can't take inline images but can read files by path: persist
        // the pasted bitmap to a temp file and attach it as a resource_link.
        try {
          const link = await writeImageBytesToTempLink(
            base64ToBytes(att.base64),
            'pasted-image.png',
            'image/png'
          )
          setAttachments((prev) => [...prev, link])
        } catch {
          toast.error('Failed to attach pasted image')
        }
      })()
    },
    [disabled, addFiles, imageCapable]
  )

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  const clearAttachments = useCallback(() => setAttachments([]), [])

  return {
    attachments,
    addFiles,
    pickFiles,
    handlePaste,
    removeAttachment,
    clearAttachments,
    canPick: !disabled,
    // Drag/paste is always accepted while enabled: images attach (inline or as
    // a temp-file link), and addFiles surfaces per-file capability issues.
    canDropPaste: !disabled
  }
}
