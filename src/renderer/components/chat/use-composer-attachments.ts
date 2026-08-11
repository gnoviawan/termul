import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { readAttachmentBytes } from '@/lib/attachment-api'
import { deleteTempFile } from '@/lib/attachment-temp-cleanup'
import {
  pickAttachmentFilesBrowser,
  pickAttachmentPaths,
  readClipboardRgbaImage,
  writeBytesToTempFile
} from '@/lib/composer-attachments-io'
import { isTauriContext } from '@/lib/tauri-runtime'
import { randomUUID } from '@/lib/uuid'
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
import type { MentionMatch } from './mention-menu-model'

function attachmentId(): string {
  return `att-${randomUUID()}`
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
  const bytes = await readAttachmentBytes(path)
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

/**
 * Read an image file by path and return a `data:` thumbnail URL, or undefined
 * when it is too large or unreadable (the card then falls back to a file icon).
 * Never throws — used for best-effort previews on the path/mention channels.
 */
async function readThumbnail(path: string, mimeType: string): Promise<string | undefined> {
  try {
    const bytes = await readAttachmentBytes(path)
    if (bytes.byteLength > MAX_IMAGE_BYTES) return undefined
    return `data:${mimeType};base64,${uint8ToBase64(bytes)}`
  } catch {
    return undefined
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
  if (!isTauriContext()) {
    // Web has no temp path. Callers must only reach here when imageCapable
    // (inline) — otherwise guard upstream and toast.
    throw new Error('Temp-link image attach is desktop-only; require imageCapable on web')
  }
  const path = await writeBytesToTempFile(bytes, safe)
  // Skip the data-URL preview when the temp file is too large to thumbnail so
  // the card falls back to an image icon instead of holding a giant base64 URL
  // in memory. The file-ref itself is still created — the agent reads by path.
  const tooLargeToPreview = bytes.byteLength > MAX_IMAGE_BYTES
  const previewUrl =
    isImageMime(mimeType) && !tooLargeToPreview
      ? `data:${mimeType};base64,${uint8ToBase64(bytes)}`
      : undefined
  return {
    kind: 'file-ref',
    id: attachmentId(),
    name: name || safe,
    mimeType,
    path,
    previewUrl,
    appOwnedTemp: true
  }
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
    const image = await readClipboardRgbaImage()
    if (!image) return null
    rgba = image.rgba
    width = image.width
    height = image.height
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
export function dataTransferFiles(data: DataTransfer): File[] {
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
  /** Mention channel (@-picker): stage a `file-ref` by absolute path. */
  addFileRef: (match: MentionMatch) => void
  /** Paste handler for the composer — images from clipboard, incl. screenshots.
   *  Accepts the DOM `ClipboardEvent` the Tiptap editor's `handlePaste` editorProp
   *  passes (the pre-refactor textarea's React event was structurally compatible;
   *  only `clipboardData` + `preventDefault()` are read, both native). */
  handlePaste: (e: ClipboardEvent) => void
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  /**
   * Paths of currently-staged app-owned temp `file-ref` attachments (e.g.
   * pasted screenshots). Callers register these with the session before sending
   * so they can be deleted when the session closes; the agent reads them by
   * path during the turn, so they must not be deleted on send.
   */
  appOwnedTempPaths: () => string[]
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
  // Mirror of `attachments` read by cleanup paths (remove / unmount) so they
  // can delete app-owned temp files without side effects inside state updaters.
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments

  // Discard any still-staged app-owned temp files when the composer unmounts.
  // `clearAttachments` clears the ref synchronously before React state updates,
  // so sent/discarded attachments are invisible here even if unmount races the
  // batched state flush (e.g. launcher hide right after send).
  useEffect(() => {
    return () => {
      for (const a of attachmentsRef.current) {
        if (a.kind === 'file-ref' && a.appOwnedTemp) void deleteTempFile(a.path)
      }
    }
  }, [])

  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files)
      if (arr.length === 0) return
      const reads: Promise<PendingAttachment>[] = []
      let tooLarge = 0
      let needEmbed = 0
      let unsupported = 0
      let needImageCap = 0
      for (const f of arr) {
        if (isImageMime(f.type)) {
          // Images always attach: inline base64 when the agent accepts images,
          // otherwise a temp-file resource_link the agent can read by path.
          // The size cap only guards the inline base64 path — a temp-link
          // attachment is read by path, so large images still attach (without a
          // preview) instead of being rejected.
          if (imageCapable) {
            if (f.size > MAX_IMAGE_BYTES) tooLarge++
            else reads.push(readImageAsAttachment(f))
          } else if (!isTauriContext()) {
            // Web has no temp path — inline without imageCapable is unusable.
            needImageCap++
          } else {
            reads.push(fileToTempLink(f))
          }
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
      if (needImageCap > 0) toast.error("This agent can't accept images in the browser")
      if (unsupported > 0) toast.error('Unsupported file type (text or image only)')
    },
    [imageCapable, embedCapable]
  )

  const pickFiles = useCallback(async () => {
    if (disabled) return

    // Web: no filesystem paths — use a DOM file picker and stage File objects.
    if (!isTauriContext()) {
      try {
        const files = await pickAttachmentFilesBrowser()
        if (files && files.length > 0) await addFiles(files)
      } catch {
        toast.error('Failed to open file picker')
      }
      return
    }

    let paths: string[] | null
    try {
      paths = await pickAttachmentPaths()
    } catch {
      toast.error('Failed to open file picker')
      return
    }
    if (!paths) return
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
          const previewUrl = await readThumbnail(path, mimeType)
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
  }, [disabled, imageCapable, addFiles])

  /**
   * Stage a `file-ref` attachment from an @-mention pick (ADR 0003). The
   * attachment is staged synchronously so it is send-safe immediately; for
   * images a thumbnail is read in the background and patched onto the card.
   */
  const addFileRef = useCallback(
    (match: MentionMatch) => {
      if (disabled) return
      const id = attachmentId()
      const name = match.name
      const mimeType = guessMimeType(name)
      setAttachments((prev) => [
        ...prev,
        { kind: 'file-ref', id, name, mimeType, path: match.absPath }
      ])
      if (isImageMime(mimeType)) {
        void (async () => {
          const previewUrl = await readThumbnail(match.absPath, mimeType)
          if (previewUrl) {
            setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, previewUrl } : a)))
          }
        })()
      }
    },
    [disabled]
  )

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      if (disabled) return
      const data = e.clipboardData
      if (!data) return
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
        if (imageCapable) {
          if ((att.base64.length * 3) / 4 > MAX_IMAGE_BYTES) {
            toast.error('Image too large (max 10 MB)')
            return
          }
          setAttachments((prev) => [...prev, att])
          return
        }
        if (!isTauriContext()) {
          toast.error("This agent can't accept images in the browser")
          return
        }
        // Agent can't take inline images but can read files by path: persist
        // the pasted bitmap to a temp file and attach it as a resource_link.
        // No size cap here — the agent reads by path; the preview is skipped
        // inside writeImageBytesToTempLink when the file is too large.
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
    const removed = attachmentsRef.current.find((a) => a.id === id)
    if (removed && removed.kind === 'file-ref' && removed.appOwnedTemp) {
      void deleteTempFile(removed.path)
    }
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }, [])

  // Send-path reset: drops React state WITHOUT deleting app-owned temp files,
  // because the agent reads them by path during the turn. Callers register the
  // paths via `appOwnedTempPaths()` before calling this so they are deleted
  // when the session closes. Clear the ref immediately so unmount cleanup
  // cannot see attachments that are already being sent.
  const clearAttachments = useCallback(() => {
    attachmentsRef.current = []
    setAttachments([])
  }, [])

  const appOwnedTempPaths = useCallback(
    () =>
      attachmentsRef.current
        .filter((a): a is Extract<PendingAttachment, { kind: 'file-ref' }> => a.kind === 'file-ref')
        .filter((a) => a.appOwnedTemp)
        .map((a) => a.path),
    []
  )

  return {
    attachments,
    addFiles,
    pickFiles,
    addFileRef,
    handlePaste,
    removeAttachment,
    clearAttachments,
    appOwnedTempPaths,
    canPick: !disabled,
    // Drag/paste is always accepted while enabled: images attach (inline or as
    // a temp-file link), and addFiles surfaces per-file capability issues.
    canDropPaste: !disabled
  }
}
