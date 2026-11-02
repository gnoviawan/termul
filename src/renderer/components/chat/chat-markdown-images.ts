import { parseMarkdownIntoBlocks } from 'streamdown'
import { mediaKindForPath } from '@/lib/media-kind'
import { escapeHtmlAttribute, localLinkPath } from './chat-markdown-file-links'

type MarkdownNode = {
  type: string
  url?: string
  alt?: string | null
  value?: string
  identifier?: string
  children?: MarkdownNode[]
}

export function termulMediaTag(url: string, alt: string, linkPreview = false): string {
  const preview = linkPreview ? ' data-link-preview="true"' : ''
  return `<termul-media data-url="${escapeHtmlAttribute(url)}" data-alt="${escapeHtmlAttribute(alt)}"${preview}></termul-media>`
}

const HTTPS_URL_RE = /^https:/i
const DATA_URL_MIME_RE = /^data:([^;,]*)(?:;[^;,]*)*,/

/** The path of an https URL without its query or fragment; any other URL as is. */
export function urlPathPart(url: string): string {
  if (!HTTPS_URL_RE.test(url)) return url
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/** What a markdown image destination renders as; anything unrecognised is an image. */
export function markdownMediaKind(url: string): 'image' | 'video' | 'audio' {
  const trimmed = url.trim()
  const dataMime = DATA_URL_MIME_RE.exec(trimmed)?.[1]
  if (dataMime === undefined) {
    return mediaKindForPath(urlPathPart(trimmed)) === 'video' ? 'video' : 'image'
  }
  if (dataMime.startsWith('video/')) return 'video'
  if (dataMime.startsWith('audio/')) return 'audio'
  return 'image'
}

export interface GalleryItem {
  url: string
  alt: string
}

export function termulGalleryTag(items: GalleryItem[]): string {
  return `<termul-gallery data-items="${escapeHtmlAttribute(JSON.stringify(items))}"></termul-gallery>`
}

/** The first definition wins, per CommonMark. */
function collectDefinitions(node: MarkdownNode, definitions: Map<string, string>): void {
  if (
    node.type === 'definition' &&
    node.identifier !== undefined &&
    node.url !== undefined &&
    !definitions.has(node.identifier)
  ) {
    definitions.set(node.identifier, node.url)
  }
  for (const child of node.children ?? []) collectDefinitions(child, definitions)
}

function imageUrl(node: MarkdownNode, definitions: Map<string, string>): string | undefined {
  if (node.type === 'image') return node.url
  if (node.type === 'imageReference' && node.identifier !== undefined) {
    return definitions.get(node.identifier)
  }
  return undefined
}

function containsImage(node: MarkdownNode): boolean {
  return (
    node.type === 'image' ||
    node.type === 'imageReference' ||
    (node.children ?? []).some(containsImage)
  )
}

function nodeText(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? ''
  return (node.children ?? []).map(nodeText).join('')
}

interface LinkPreview {
  path: string
  tag: string
}

function linkUrl(node: MarkdownNode, definitions: Map<string, string>): string | undefined {
  if (node.type === 'link') return node.url
  if (node.type === 'linkReference' && node.identifier !== undefined) {
    return definitions.get(node.identifier)
  }
  return undefined
}

function mediaLinkPreview(
  node: MarkdownNode,
  definitions: Map<string, string>
): LinkPreview | null {
  const url = linkUrl(node, definitions)
  if (url === undefined || containsImage(node)) return null
  const path = localLinkPath(url)
  const kind = path === null ? null : mediaKindForPath(path)
  if (path === null || (kind !== 'image' && kind !== 'video')) return null
  const target = url.trim().replace(/[?#][\s\S]*$/, '')
  return { path, tag: termulMediaTag(target, nodeText(node).trim() || path, true) }
}

/** Streamdown's stand-in for an image whose destination is still streaming. */
const INCOMPLETE_IMAGE_PREFIX = 'streamdown:'

/**
 * The images of a paragraph that holds only still images and whitespace, else
 * null. A video keeps its own player and an empty destination its alt chip, so
 * either breaks the run. A still-streaming image neither counts nor breaks it.
 */
function imageOnlyParagraph(
  node: MarkdownNode,
  definitions: Map<string, string>
): GalleryItem[] | null {
  if (node.type !== 'paragraph' || !node.children) return null
  const items: GalleryItem[] = []
  let sawImage = false
  for (const child of node.children) {
    const url = imageUrl(child, definitions)
    if (url?.startsWith(INCOMPLETE_IMAGE_PREFIX)) {
      sawImage = true
    } else if (url?.trim() && markdownMediaKind(url) === 'image') {
      sawImage = true
      items.push({ url, alt: child.alt ?? '' })
    } else if (child.type !== 'break' && !(child.type === 'text' && !child.value?.trim())) {
      return null
    }
  }
  return sawImage ? items : null
}

/** A run of image-only paragraphs holding two or more images becomes one gallery strip. */
function groupImageRuns(node: MarkdownNode, definitions: Map<string, string>): void {
  if (!node.children) return
  const grouped: MarkdownNode[] = []
  let items: GalleryItem[] = []
  let run: MarkdownNode[] = []
  const flush = (): void => {
    if (items.length >= 2) grouped.push({ type: 'html', value: termulGalleryTag(items) })
    else grouped.push(...run)
    items = []
    run = []
  }
  for (const child of node.children) {
    const images = imageOnlyParagraph(child, definitions)
    if (images) {
      items.push(...images)
      run.push(child)
    } else {
      flush()
      grouped.push(child)
    }
  }
  flush()
  node.children = grouped
}

/** Previews of media links render after the paragraph or heading, so the sentence stays whole. */
const PREVIEW_HOSTS: ReadonlySet<string> = new Set(['paragraph', 'heading'])

function transformChildren(node: MarkdownNode, definitions: Map<string, string>): LinkPreview[] {
  if (!node.children) return []
  groupImageRuns(node, definitions)
  const bubbled: LinkPreview[] = []
  node.children = node.children.flatMap((child) => {
    // `url !== undefined` also rewrites empty destinations (`![]()`), which
    // would otherwise render `[Image blocked: ]` on the default pipeline.
    const url = imageUrl(child, definitions)
    if (url !== undefined) {
      return [{ type: 'html', value: termulMediaTag(url, child.alt ?? '') }]
    }
    const preview = mediaLinkPreview(child, definitions)
    if (preview !== null) {
      bubbled.push(preview)
      return [child]
    }
    const previews = transformChildren(child, definitions)
    if (!PREVIEW_HOSTS.has(child.type)) {
      bubbled.push(...previews)
      return [child]
    }
    const seen = new Set<string>()
    const unique = previews.filter(({ path }) => !seen.has(path) && seen.add(path))
    return [child, ...unique.map(({ tag }) => ({ type: 'html', value: tag }))]
  })
  return bubbled
}

/**
 * `<termul-media>` and `<termul-gallery>` survive `rehype-sanitize` only
 * because they are registered via the `allowedTags` prop; `rehype-harden`
 * ignores them.
 */
export function remarkTermulMedia(): (tree: MarkdownNode) => void {
  return (tree) => {
    const definitions = new Map<string, string>()
    collectDefinitions(tree, definitions)
    transformChildren(tree, definitions)
  }
}

const IMAGE_ONLY_BLOCK_RE = /^\s*(?:!\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)\s*)+$/

/**
 * Streamdown renders each block separately while streaming, so consecutive
 * image-only blocks are joined here for `remarkTermulMedia` to see them as
 * one run.
 */
export function parseChatMarkdownBlocks(markdown: string): string[] {
  const blocks: string[] = []
  for (const block of parseMarkdownIntoBlocks(markdown)) {
    const last = blocks.length - 1
    if (last >= 0 && IMAGE_ONLY_BLOCK_RE.test(block) && IMAGE_ONLY_BLOCK_RE.test(blocks[last])) {
      blocks[last] += block
    } else {
      blocks.push(block)
    }
  }
  return blocks
}

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/
const FILE_URL_PREFIX_RE = /^file:\/\//i

/**
 * Percent-decode a markdown URL the way `decodeURI` does. Returns null on
 * malformed percent escapes (`file:///%zz`) instead of throwing — this runs
 * during React render, so a malformed URL must degrade to the alt-text chip,
 * never crash the chat tree. Reserved escapes (e.g. `%2F`) stay encoded so a
 * literal slash in a filename cannot become a path separator.
 */
function safeDecodeUrl(url: string): string | null {
  try {
    return decodeURI(url)
  } catch {
    return null
  }
}

function normalizeSeparators(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Collapse `.`/`..` segments and duplicate separators in an absolute path. */
function canonicalizeAbsolutePath(p: string): string {
  const normalized = normalizeSeparators(p)
  let prefix = ''
  let rest = normalized
  if (/^[A-Za-z]:\//.test(normalized)) {
    prefix = normalized.slice(0, 3)
    rest = normalized.slice(3)
  } else if (normalized.startsWith('//')) {
    prefix = '//'
    rest = normalized.slice(2)
  } else if (normalized.startsWith('/')) {
    prefix = '/'
    rest = normalized.slice(1)
  }

  const parts: string[] = []
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return `${prefix}${parts.join('/')}`
}

/**
 * Resolve a `file://` or relative markdown image URL against the chat cwd into
 * an absolute OS path for the `readMediaBytes` read. The URL is
 * percent-decoded first (markdown destinations keep %-encoding). Returns null
 * so the caller can fall back to the alt-text chip when the URL is not
 * locally readable: malformed percent escapes, protocol-relative `//host/…`,
 * UNC `\\server\share` shapes, `file://` URLs with an authority component
 * (remote shares), other schemes, or a relative path with no cwd.
 */
export function resolveLocalImagePath(url: string, cwd?: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null

  if (FILE_URL_PREFIX_RE.test(trimmed)) {
    const decodedRest = safeDecodeUrl(trimmed.slice('file://'.length))
    if (decodedRest === null) return null
    // An authority component (file://server/share/x.png) is a remote share,
    // not a local read; a local file URL has an empty authority (file:///x).
    if (!decodedRest.startsWith('/')) return null
    // Strip the leading slash from Windows drive paths (/E:/x -> E:/x).
    return /^\/[A-Za-z]:/.test(decodedRest) ? decodedRest.slice(1) : decodedRest
  }

  const decoded = safeDecodeUrl(trimmed)
  if (decoded === null) return null
  if (decoded.startsWith('//') || decoded.startsWith('\\\\')) return null
  if (WINDOWS_DRIVE_RE.test(decoded)) return canonicalizeAbsolutePath(decoded)
  if (URI_SCHEME_RE.test(decoded)) return null
  if (decoded.startsWith('/') || decoded.startsWith('\\')) {
    return canonicalizeAbsolutePath(decoded)
  }
  if (!cwd) return null
  const base = normalizeSeparators(cwd).replace(/\/+$/, '')
  return canonicalizeAbsolutePath(`${base}/${normalizeSeparators(decoded)}`)
}
