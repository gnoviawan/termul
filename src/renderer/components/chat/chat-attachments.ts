import type { FileUIPart } from 'ai'
import type { ContentBlock } from '@/lib/acp-api'

/**
 * A file/image staged in the composer before sending. The variant is keyed on
 * how the file reached us, which determines the ACP block it becomes:
 *
 * - `image`      — browser File bytes -> ACP `image` block (base64).
 * - `file-ref`   — a real filesystem path (OS picker) -> ACP `resource_link`.
 * - `file-embed` — browser File text (drag/paste, no path) -> embedded `resource`.
 *
 * See docs/adr/0001-agent-chat-file-attachment-transport.md.
 */
export type PendingAttachment =
  | {
      kind: 'image'
      id: string
      name: string
      mimeType: string
      /** Full `data:` URL for preview. */
      previewUrl: string
      /** Base64 payload (no data-URL prefix) for the ACP image block. */
      base64: string
    }
  | {
      kind: 'file-ref'
      id: string
      name: string
      mimeType: string
      path: string
      /** Data-URL thumbnail when the linked file is an image. */
      previewUrl?: string
      /**
       * True when the temp file at `path` was created by the app (e.g. a pasted
       * screenshot written via `writeImageBytesToTempLink`). These files are
       * deleted on discard / session close so they do not linger in the OS temp
       * dir; false (default) for user-selected OS-picker paths the app must not
       * delete.
       */
      appOwnedTemp?: boolean
    }
  | { kind: 'file-embed'; id: string; name: string; mimeType: string; text: string; size: number }

/** Max bytes for an inline image attachment. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
/** Max bytes for an embedded text file (keeps the context window sane). */
export const MAX_EMBED_BYTES = 512 * 1024

const EXT_MIME: Record<string, string> = {
  // text / docs
  txt: 'text/plain',
  md: 'text/markdown',
  mdx: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  log: 'text/plain',
  rtf: 'text/rtf',
  // data / config
  json: 'application/json',
  jsonc: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  ini: 'text/plain',
  env: 'text/plain',
  cfg: 'text/plain',
  conf: 'text/plain',
  properties: 'text/plain',
  // web
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  scss: 'text/x-scss',
  sass: 'text/x-sass',
  less: 'text/x-less',
  svg: 'image/svg+xml',
  // code
  js: 'text/javascript',
  cjs: 'text/javascript',
  mjs: 'text/javascript',
  jsx: 'text/jsx',
  ts: 'text/typescript',
  tsx: 'text/tsx',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  rs: 'text/x-rust',
  go: 'text/x-go',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  swift: 'text/x-swift',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  cc: 'text/x-c++',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  php: 'text/x-php',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  ps1: 'text/x-powershell',
  sql: 'application/sql',
  graphql: 'application/graphql',
  gql: 'application/graphql',
  vue: 'text/plain',
  svelte: 'text/plain',
  // images (picker -> resource_link)
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

/** Extension-less filenames that are still plain text. */
const TEXT_BASENAMES = new Set([
  'dockerfile',
  'makefile',
  'rakefile',
  'gemfile',
  'procfile',
  'license',
  'readme',
  '.gitignore',
  '.gitattributes',
  '.env',
  '.npmrc',
  '.editorconfig',
  '.prettierrc',
  '.eslintrc',
  '.babelrc'
])

/** Lower-cased extension without the dot, or '' when there is none. */
export function fileExtension(name: string): string {
  const base = basename(name)
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** Last path segment, splitting on both `/` and `\`. */
export function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

export function isImageMime(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.startsWith('image/'))
}

/** True for files an LLM can read as text (code, config, docs). */
export function isTextLike(name: string, mimeType?: string): boolean {
  if (mimeType) {
    if (mimeType.startsWith('text/')) return true
    if (
      mimeType === 'application/json' ||
      mimeType === 'application/xml' ||
      mimeType === 'application/yaml' ||
      mimeType === 'application/toml' ||
      mimeType === 'application/sql' ||
      mimeType === 'application/graphql'
    ) {
      return true
    }
  }
  const ext = fileExtension(name)
  if (!ext) return TEXT_BASENAMES.has(basename(name).toLowerCase())
  const mapped = EXT_MIME[ext]
  if (!mapped) return false
  return !isImageMime(mapped) || ext === 'svg'
}

/** Best-effort MIME type from a filename; defaults to text/plain. */
export function guessMimeType(name: string): string {
  return EXT_MIME[fileExtension(name)] ?? 'text/plain'
}

/**
 * Convert an absolute OS path to a `file://` URL. Handles Windows drive paths
 * (`D:\a\b` -> `file:///D:/a/b`) and encodes spaces and other unsafe chars
 * while preserving `/` and `:`.
 */
export function pathToFileUrl(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const withSlash = norm.startsWith('/') ? norm : `/${norm}`
  return `file://${encodeURI(withSlash)}`
}

/** Encode raw bytes to a base64 string, chunked to avoid call-stack limits. */
export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Map a staged attachment to its ACP content block. */
export function attachmentToBlock(a: PendingAttachment): ContentBlock {
  switch (a.kind) {
    case 'image':
      return { type: 'image', mimeType: a.mimeType, data: a.base64 }
    case 'file-ref':
      return {
        type: 'resource_link',
        uri: pathToFileUrl(a.path),
        name: a.name,
        mimeType: a.mimeType
      }
    case 'file-embed':
      return {
        type: 'resource',
        resource: {
          uri: `attachment:///${encodeURIComponent(a.name)}`,
          mimeType: a.mimeType,
          text: a.text
        }
      }
  }
}

/**
 * Drop duplicate `resource_link` blocks by URI (e.g. the same file staged via
 * the @-picker and the OS picker). Text/image/embed blocks are passed through
 * untouched. See ADR 0003.
 */
export function dedupeAttachmentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const seen = new Set<string>()
  const out: ContentBlock[] = []
  for (const b of blocks) {
    if (b.type === 'resource_link') {
      const uri = b.uri as string | undefined
      if (uri) {
        if (seen.has(uri)) continue
        seen.add(uri)
      }
    }
    out.push(b)
  }
  return out
}

const GUID_STEM_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i
const GUID_LIKE_STEM_RE = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-/i
const FAIZUI_TEMP_RE = /^faizui-[0-9a-f-]+-/i
const GENERIC_IMAGE_NAMES = new Set(['', 'image', 'image.png', 'pasted-image.png'])

function stemWithoutExtension(name: string): string {
  const base = basename(name.trim())
  const dot = base.lastIndexOf('.')
  if (dot > 0) return base.slice(0, dot)
  return base
}

/** True when a filename is a GUID, temp prefix, or other non-human label. */
export function isOpaqueAttachmentName(name: string): boolean {
  const base = basename(name.trim())
  if (GENERIC_IMAGE_NAMES.has(base.toLowerCase())) return true
  if (FAIZUI_TEMP_RE.test(base)) return true

  const stem = stemWithoutExtension(base)
  if (GENERIC_IMAGE_NAMES.has(stem.toLowerCase())) return true
  if (GUID_STEM_RE.test(stem)) return true
  if (GUID_LIKE_STEM_RE.test(stem)) return true
  return false
}

const DISPLAY_NAME_MAX = 24

function truncateDisplayName(name: string): string {
  if (name.length <= DISPLAY_NAME_MAX) return name
  return `${name.slice(0, DISPLAY_NAME_MAX - 1)}…`
}

/**
 * Friendly label for attachment UI — hides GUIDs and generic paste names.
 */
export function humanizeAttachmentName(name: string): string {
  const base = basename(name.trim())
  if (isOpaqueAttachmentName(base)) {
    const lower = base.toLowerCase()
    if (lower.includes('screenshot') || lower === 'pasted-image.png') return 'Screenshot'
    return 'Image'
  }
  return truncateDisplayName(base)
}

/** Accessible label when the visible UI omits the raw filename. */
export function attachmentAriaLabel(name: string): string {
  const human = humanizeAttachmentName(name)
  const base = basename(name.trim())
  if (human === base || isOpaqueAttachmentName(base)) return human
  return `${human} (${base})`
}

/** Display name for an incoming/own content block (text/image/resource/link). */
export function blockDisplayName(block: ContentBlock): string {
  const direct = (block.name ?? block.title) as string | undefined
  if (direct) return humanizeAttachmentName(direct)
  const resource = blockResource(block)
  const uri = (block.uri as string | undefined) ?? resource?.uri
  if (uri) {
    let raw: string
    try {
      raw = decodeURIComponent(basename(uri.replace(/[?#].*$/, '')))
    } catch {
      raw = basename(uri)
    }
    return humanizeAttachmentName(raw)
  }
  if (block.type === 'image') return 'Image'
  return block.type
}

/**
 * Convert a `file://` URL back to a filesystem path readable by plugin-fs /
 * `editorStore.openFile`. Strips the leading slash from Windows drive paths
 * (`file:///D:/a/b` -> `D:/a/b`). Non-`file://` URIs are returned unchanged so
 * callers can pass `attachment:///` URIs through without extra branching.
 */
export function fileUrlToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri
  let p = decodeURI(uri.slice('file://'.length))
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1) // /C:/x -> C:/x
  return p
}

/** Whether a `file://` (or bare absolute) URI points at a file we can open. */
export function isLocalFileUri(uri: string | undefined): uri is string {
  return Boolean(
    uri && (uri.startsWith('file://') || /^[A-Za-z]:[\\/]/.test(uri) || uri.startsWith('/'))
  )
}

/** Best-effort MIME type for an incoming/own content block. */
export function blockMimeType(block: ContentBlock): string | undefined {
  const direct = block.mimeType as string | undefined
  if (direct) return direct
  const resource = blockResource(block)
  return resource?.mimeType
}

/** URI of a content block: direct `uri` (image/resource_link) or nested `resource.uri`. */
export function blockUri(block: ContentBlock): string | undefined {
  const direct = block.uri as string | undefined
  if (direct) return direct
  return blockResource(block)?.uri
}

/** Inline base64 payload of an `image` block (the `data` field). */
export function blockData(block: ContentBlock): string | undefined {
  return block.data as string | undefined
}

/** Nested `resource` object of a `resource` block (uri/mimeType/text). */
export function blockResource(
  block: ContentBlock
): { uri?: string; mimeType?: string; text?: string } | undefined {
  return block.resource as { uri?: string; mimeType?: string; text?: string } | undefined
}

/** True when a URI is directly renderable in an `<img>`/`<video>` src (no Tauri fetch). */
function isRenderableUrl(uri: string): boolean {
  return (
    uri.startsWith('data:') ||
    uri.startsWith('http:') ||
    uri.startsWith('https:') ||
    uri.startsWith('blob:')
  )
}

/**
 * Map a staged composer attachment to an AI Elements `AttachmentData` file part.
 * Image/file-ref carry a preview data URL when available; embedded text has none
 * (the card falls back to a document icon).
 */
export function pendingToAttachmentData(a: PendingAttachment): FileUIPart & { id: string } {
  const url = a.kind === 'file-embed' ? '' : (a.previewUrl ?? '')
  // Hide opaque paste/GUID image names in the badge; keep real filenames for
  // non-image refs/embeds (CSS truncates the visible width).
  const filename = a.kind !== 'file-embed' && a.previewUrl ? humanizeAttachmentName(a.name) : a.name
  return {
    type: 'file',
    id: a.id,
    filename,
    mediaType: a.mimeType,
    url
  }
}

/**
 * Map an incoming/own ACP content block to an AI Elements `AttachmentData` file
 * part. Inline `image` blocks (base64) and data/http URIs become a renderable
 * `url` immediately; `file://` URIs are left empty for the bubble to resolve
 * lazily via the brokered `readAttachmentBytes` command.
 */
export function blockToAttachmentData(
  block: ContentBlock,
  id: string
): FileUIPart & { id: string } {
  const filename = blockDisplayName(block)
  const mimeType = blockMimeType(block) ?? 'application/octet-stream'

  if (block.type === 'image') {
    const data = blockData(block)
    return {
      type: 'file',
      id,
      filename,
      mediaType: mimeType,
      url: data ? `data:${mimeType};base64,${data}` : ''
    }
  }

  const uri = blockUri(block) ?? ''
  return {
    type: 'file',
    id,
    filename,
    mediaType: mimeType,
    url: isRenderableUrl(uri) ? uri : ''
  }
}
