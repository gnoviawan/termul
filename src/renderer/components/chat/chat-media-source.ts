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

/**
 * One piece of media the chat can show inline, whichever shape the agent
 * emitted it in: a markdown image, a markdown link to a media file, or an ACP
 * `image` / `audio` / `resource` / `resource_link` block.
 */
export type ChatMedia =
  | { kind: 'image' | 'video'; name: string; src: PathSource | UrlSource | BytesSource }
  // Audio has no host read path (the media table has no audio extensions).
  | { kind: 'audio'; name: string; src: UrlSource | BytesSource }

export type ChatMediaKind = ChatMedia['kind']

/** A local file, read through `readMediaBytes`. */
export interface PathSource {
  from: 'path'
  path: string
}

/** A URL the element loads itself: `https:`, `blob:`, or a `data:` image. */
export interface UrlSource {
  from: 'url'
  url: string
}

/**
 * Inline base64 bytes, shown through a `blob:` URL: the desktop CSP allows
 * `blob:` but not `data:` in `media-src`.
 */
export interface BytesSource {
  from: 'bytes'
  base64: string
  mime: string
}

const MIB = 1024 * 1024

/** Largest inline payload decoded into a blob, per kind. */
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

/** The extension-bearing part of a URL: an https pathname, else the whole string. */
function urlPathPart(url: string): string {
  if (!HTTPS_URL_RE.test(url)) return url
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function fromBase64(
  kind: ChatMediaKind,
  name: string,
  base64: string,
  mime: string
): ChatMedia | null {
  if (base64.length * 0.75 > INLINE_MAX_BYTES[kind]) return null
  return { kind, name, src: { from: 'bytes', base64, mime } }
}

/** A `data:` URL as media of `kind`; images stay URLs, video and audio become bytes. */
function fromDataUrl(url: string, kind: ChatMediaKind, name: string): ChatMedia | null {
  const match = DATA_URL_RE.exec(url)
  if (!match) return null
  const [, mime, params, payload] = match
  if (kind === 'image') return { kind, name, src: { from: 'url', url } }
  if (!params.split(';').includes('base64')) return null
  return fromBase64(kind, name, payload, mime)
}

/**
 * A URI or markdown destination as media of `kind`. `cwd` resolves relative
 * paths. Remote audio is not loaded: it has no user gesture in front of it.
 */
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

/** An inline ACP payload: raw base64 (the ACP shape), a `data:` URL, or a `blob:` URL. */
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
