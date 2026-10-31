import type { ContentBlock } from '@/lib/acp-api'
import { MEDIA_MAX_BYTES, mediaKindForPath } from '@/lib/media-kind'
import {
  blockData,
  blockDisplayName,
  blockMimeType,
  blockResource,
  blockUri
} from './chat-attachments'
import { resolveLocalImagePath } from './chat-markdown-images'

export type ChatMedia =
  | { kind: 'image' | 'video'; name: string; src: PathSource | UrlSource | BytesSource }
  | { kind: 'audio'; name: string; src: UrlSource | BytesSource }

export type ChatMediaKind = ChatMedia['kind']

export interface PathSource {
  from: 'path'
  path: string
}

export interface UrlSource {
  from: 'url'
  url: string
}

export interface BytesSource {
  from: 'bytes'
  base64: string
  mime: string
}

const MIB = 1024 * 1024

const INLINE_MAX_BYTES: Readonly<Record<ChatMediaKind, number>> = {
  image: MEDIA_MAX_BYTES.image,
  video: MEDIA_MAX_BYTES.video,
  audio: 20 * MIB
}

const DATA_URL_RE = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s
const HTTPS_URL_RE = /^https:/i

function kindForMime(mime: string | undefined): ChatMediaKind | null {
  if (mime?.startsWith('image/')) return 'image'
  if (mime?.startsWith('video/')) return 'video'
  if (mime?.startsWith('audio/')) return 'audio'
  return null
}

function kindForPath(path: string): 'image' | 'video' | null {
  const kind = mediaKindForPath(path)
  return kind === 'image' || kind === 'video' ? kind : null
}

function urlPathPart(url: string): string {
  if (!HTTPS_URL_RE.test(url)) return url
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

export function decodedLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

function fromBase64(
  kind: ChatMediaKind,
  name: string,
  base64: string,
  mime: string
): ChatMedia | null {
  if (decodedLength(base64) > INLINE_MAX_BYTES[kind]) return null
  return { kind, name, src: { from: 'bytes', base64, mime } }
}

function fromDataUrl(url: string, kind: ChatMediaKind, name: string): ChatMedia | null {
  const match = DATA_URL_RE.exec(url)
  if (!match) return null
  const [, mime, params, payload] = match
  if (kind === 'image') return { kind, name, src: { from: 'url', url } }
  if (!params.split(';').includes('base64')) return null
  return fromBase64(kind, name, payload, mime)
}

function fromUri(
  uri: string,
  kind: ChatMediaKind,
  name: string,
  cwd: string | undefined
): ChatMedia | null {
  const trimmed = uri.trim()
  if (trimmed.startsWith('blob:')) return { kind, name, src: { from: 'url', url: trimmed } }
  if (/^data:/i.test(trimmed)) return fromDataUrl(trimmed, kind, name)
  if (kind === 'audio') return null
  if (HTTPS_URL_RE.test(trimmed)) return { kind, name, src: { from: 'url', url: trimmed } }
  const path = resolveLocalImagePath(trimmed, cwd)
  if (path === null || kindForPath(path) !== kind) return null
  return { kind, name, src: { from: 'path', path } }
}

/**
 * The media a markdown image `![alt](url)` or a local media link
 * `[alt](url)` shows, or null when it cannot render (the caller shows the alt
 * chip or the file button). A local file must have an image or video
 * extension; a remote or inline URL without one is taken as an image.
 */
export function chatMediaFromMarkdown(
  url: string,
  alt: string,
  cwd: string | undefined
): ChatMedia | null {
  const trimmed = url.trim()
  if (!trimmed) return null
  const dataMime = DATA_URL_RE.exec(trimmed)?.[1]
  const kind =
    (dataMime === undefined ? kindForPath(urlPathPart(trimmed)) : kindForMime(dataMime)) ?? 'image'
  return fromUri(trimmed, kind, alt, cwd)
}

function fromInlineData(
  data: string,
  kind: ChatMediaKind,
  name: string,
  mime: string | undefined
): ChatMedia | null {
  if (data.startsWith('blob:') || data.startsWith('data:'))
    return fromUri(data, kind, name, undefined)
  return fromBase64(kind, name, data, mime ?? '')
}

/**
 * The media an ACP content block shows inline, or null for blocks that render
 * as a file card or embedded text. Kind comes from the MIME type, then from
 * the URI's or the name's extension.
 */
export function chatMediaFromBlock(block: ContentBlock): ChatMedia | null {
  const name = blockDisplayName(block)
  const mime = blockMimeType(block)
  const uri = blockUri(block)
  const data = blockData(block)

  if (block.type === 'image') {
    if (data) return fromInlineData(data, 'image', name, mime)
    return uri ? fromUri(uri, 'image', name, undefined) : null
  }
  if (block.type === 'audio') {
    return data && kindForMime(mime) === 'audio' ? fromInlineData(data, 'audio', name, mime) : null
  }
  if (block.type !== 'resource' && block.type !== 'resource_link') return null

  const resource = blockResource(block)
  if (typeof resource?.text === 'string') return null
  const kind =
    kindForMime(mime) ??
    (uri ? kindForPath(urlPathPart(uri)) : null) ??
    kindForPath(typeof block.name === 'string' ? block.name : '')
  if (kind === null) return null
  if (resource?.blob) return fromBase64(kind, name, resource.blob, mime ?? '')
  return uri ? fromUri(uri, kind, name, undefined) : null
}
