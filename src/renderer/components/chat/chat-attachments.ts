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

/** Display name for an incoming/own content block (text/image/resource/link). */
export function blockDisplayName(block: ContentBlock): string {
  const direct = (block.name ?? block.title) as string | undefined
  if (direct) return direct
  const resource = block.resource as { uri?: string } | undefined
  const uri = (block.uri as string | undefined) ?? resource?.uri
  if (uri) {
    try {
      return decodeURIComponent(basename(uri.replace(/[?#].*$/, '')))
    } catch {
      return basename(uri)
    }
  }
  return block.type
}

/** Best-effort MIME type for an incoming/own content block. */
export function blockMimeType(block: ContentBlock): string | undefined {
  const direct = block.mimeType as string | undefined
  if (direct) return direct
  const resource = block.resource as { mimeType?: string } | undefined
  return resource?.mimeType
}
