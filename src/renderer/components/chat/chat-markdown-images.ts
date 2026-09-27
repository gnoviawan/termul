import { escapeHtmlAttribute } from './chat-markdown-file-links'

type MarkdownNode = {
  type: string
  url?: string
  alt?: string | null
  children?: MarkdownNode[]
}

/** Whether a markdown image URL keeps streamdown's default https? pipeline. */
function isHttpUrl(url: string): boolean {
  return /^https?:/i.test(url)
}

/** Raw HTML for the custom image element the sanitizer keeps and harden ignores. */
export function termulImageTag(url: string, alt: string): string {
  return `<termul-image data-url="${escapeHtmlAttribute(url)}" data-alt="${escapeHtmlAttribute(alt)}"></termul-image>`
}

function transformChildren(node: MarkdownNode): void {
  if (!node.children) return
  node.children = node.children.flatMap((child) => {
    // `url !== undefined` also rewrites empty destinations (`![]()`), which
    // would otherwise render `[Image blocked: ]` on the default pipeline.
    if (child.type === 'image' && child.url !== undefined && !isHttpUrl(child.url)) {
      return [{ type: 'html', value: termulImageTag(child.url, child.alt ?? '') }]
    }
    transformChildren(child)
    return [child]
  })
}

/**
 * Streamdown remark plugin that rewrites non-`https?` markdown images into
 * `<termul-image data-url data-alt>` raw-HTML nodes. The custom element
 * survives `rehype-sanitize` (registered via the `allowedTags` prop) so
 * `data:`/`file:`/relative images no longer become `[Image blocked: …]`.
 * Walks every parent (lists, quotes, links, table cells), not just paragraphs.
 */
export function remarkTermulImages(): (tree: MarkdownNode) => void {
  return (tree) => {
    transformChildren(tree)
  }
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
 * an absolute OS path for the brokered `readAttachmentBytes` read. The URL is
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
