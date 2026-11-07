/**
 * Saves a chat image to disk from its source bytes. The Tauri CSP blocks
 * `fetch` of `blob:`, `data:` and `https:` URLs, so a path is read through
 * `readMediaBytes`, inline bytes and `data:` URLs are decoded in place, and a
 * remote URL opens in the system browser when it cannot be fetched. Desktop
 * asks for a location with the save dialog; the browser and phone use an
 * anchor download.
 */
import { writeFile } from '@tauri-apps/plugin-fs'
import { requestExternalLinkOpen } from '@/components/external-link/ExternalLinkConfirm'
import { dialogApi } from '@/lib/dialog-api'
import { readMediaBytes } from '@/lib/media-bytes-api'
import { MEDIA_TYPES, mediaKindForPath } from '@/lib/media-kind'
import { isTauriContext } from '@/lib/tauri-runtime'

export type ImageSource =
  | { from: 'path'; path: string }
  | { from: 'url'; url: string }
  | { from: 'bytes'; base64: string; mime: string }

export type ImageDownloadResult = 'saved' | 'cancelled' | 'opened-externally'

const DATA_URL_RE = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s
const REMOTE_URL_RE = /^(?:https?|blob):/i
const UNSAFE_FILE_NAME_CHARS = /[\\/:*?"<>|]+/g
// WebKit can abort an anchor download whose object URL is revoked right away.
const REVOKE_DELAY_MS = 30_000

const IMAGE_EXTENSION_BY_MIME: ReadonlyMap<string, string> = new Map(
  Object.entries(MEDIA_TYPES)
    .filter(([, type]) => type.kind === 'image')
    .reverse()
    .map(([ext, type]) => [type.mime, ext])
)

/** The MIME type of a `data:` URL, or undefined for any other URL. */
export function dataUrlMime(url: string): string | undefined {
  return DATA_URL_RE.exec(url)?.[1]
}

/**
 * A file name safe to save: no control or path characters, no trailing dots or
 * spaces, and an image extension, taken from the MIME type when missing.
 */
export function imageFileName(name: string, mime = ''): string {
  const printable = [...name].filter((ch) => ch >= ' ' && ch !== '\u007f').join('')
  const clean = printable
    .replace(UNSAFE_FILE_NAME_CHARS, '_')
    .replace(/[. ]+$/, '')
    .trim()
  if (clean && mediaKindForPath(clean) === 'image') return clean
  const ext = IMAGE_EXTENSION_BY_MIME.get(mime.split(';')[0].trim().toLowerCase()) ?? 'png'
  return `${clean || 'image'}.${ext}`
}

function base64Bytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function dataUrlBlob(url: string): Blob {
  const match = DATA_URL_RE.exec(url)
  if (!match) throw new Error('Unsupported image URL')
  const [, mime, params, payload] = match
  const bytes = params.split(';').includes('base64')
    ? base64Bytes(payload)
    : new TextEncoder().encode(decodeURIComponent(payload))
  return new Blob([bytes], { type: mime })
}

async function sourceBlob(source: ImageSource): Promise<Blob> {
  switch (source.from) {
    case 'path': {
      const result = await readMediaBytes(source.path)
      if (!result.success) throw new Error(`${result.code}: ${result.error}`)
      return result.data
    }
    case 'bytes':
      return new Blob([base64Bytes(source.base64)], { type: source.mime })
    case 'url':
      return dataUrlBlob(source.url)
  }
}

function anchorDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}

async function saveBlob(blob: Blob, fileName: string): Promise<ImageDownloadResult> {
  const name = imageFileName(fileName, blob.type)
  if (!isTauriContext()) {
    anchorDownload(blob, name)
    return 'saved'
  }
  const target = await dialogApi.saveFile({ title: 'Save image', defaultPath: name })
  if (!target.success) {
    if (target.code === 'CANCELLED') return 'cancelled'
    throw new Error(target.error)
  }
  await writeFile(target.data, new Uint8Array(await blob.arrayBuffer()))
  return 'saved'
}

function openExternally(url: string): ImageDownloadResult {
  if (!requestExternalLinkOpen(url)) throw new Error('Could not open the image link')
  return 'opened-externally'
}

async function fetchBlob(url: string): Promise<Blob> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.blob()
}

/** Throws on any failure so the caller can tell the user. */
export async function downloadImage(
  source: ImageSource,
  fileName: string
): Promise<ImageDownloadResult> {
  if (source.from === 'url' && REMOTE_URL_RE.test(source.url)) {
    if (isTauriContext()) return openExternally(source.url)
    let blob: Blob
    try {
      blob = await fetchBlob(source.url)
    } catch {
      return openExternally(source.url)
    }
    return saveBlob(blob, fileName)
  }
  return saveBlob(await sourceBlob(source), fileName)
}
