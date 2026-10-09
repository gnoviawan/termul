import { findFilePathMatches } from '@/lib/file-path-links'

/**
 * Escape `& < > "` so interpolated path/alt/url values cannot break out of
 * the raw HTML we emit for `termul-file-path` / `termul-image` elements.
 */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

/**
 * Raw HTML for a custom element the sanitizer keeps and harden ignores. The
 * visible label defaults to the path (bare prose paths); markdown links pass
 * their link text.
 */
export function termulFilePathTag(path: string, label: string = path): string {
  return `<termul-file-path data-path="${escapeHtmlAttribute(path)}">${escapeHtmlAttribute(label)}</termul-file-path>`
}

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/
const FILE_URL_RE = /^file:/i
const LINE_FRAGMENT_RE = /^L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i
// `name.ext:42` is a file with a line suffix. The extension is required so
// numeric URI schemes such as `tel:123` / `sms:555` stay ordinary links.
const PATH_LINE_RE = /^[^:/\\]*\.[^:/\\.]+:\d+(?::\d+)?$/
const UNC_PREFIX_RE = /^[\\/]{2}/
const LINE_SUFFIX_RE = /:\d+(?::\d+)?$/

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

/** Path for a `file:` URL with an empty/`localhost` authority, else null. */
function fileUrlPath(decodableRest: string): string | null {
  let rest = decodableRest
  if (rest.startsWith('//')) {
    const slash = rest.indexOf('/', 2)
    const authority = slash === -1 ? rest.slice(2) : rest.slice(2, slash)
    if (authority !== '' && authority.toLowerCase() !== 'localhost') return null
    rest = slash === -1 ? '' : rest.slice(slash)
  }
  const decoded = safeDecode(rest)
  if (decoded === null || !decoded.startsWith('/') || decoded === '/') return null
  // `file:////server/share` decodes to a UNC path: a remote share, not a local read.
  if (UNC_PREFIX_RE.test(decoded)) return null
  // Strip the leading slash from Windows drive paths (/C:/x -> C:/x).
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded
}

/**
 * The local path a markdown link destination points at, or null when the link
 * must stay a normal link (http(s), mailto, javascript:, `#anchor`,
 * protocol-relative `//host`, remote `file://host/…`, malformed escapes).
 * A `#L<n>` fragment becomes a `:<n>` line suffix; other fragments are dropped.
 */
function localLinkPath(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  const hashIndex = trimmed.indexOf('#')
  const beforeFragment = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex)
  const fragment = hashIndex === -1 ? '' : trimmed.slice(hashIndex + 1)
  const queryIndex = beforeFragment.indexOf('?')
  const target = queryIndex === -1 ? beforeFragment : beforeFragment.slice(0, queryIndex)

  let path: string | null
  if (FILE_URL_RE.test(target)) {
    path = fileUrlPath(target.slice('file:'.length))
  } else {
    path = safeDecode(target)
    if (path !== null) {
      if (UNC_PREFIX_RE.test(path)) return null
      // `a.ts:42` is a path with a line suffix, not a URI scheme.
      if (!WINDOWS_DRIVE_RE.test(path) && !PATH_LINE_RE.test(path) && URI_SCHEME_RE.test(path)) {
        return null
      }
    }
  }
  if (!path || hasControlChar(path)) return null

  const line = LINE_FRAGMENT_RE.exec(fragment)
  return line && !LINE_SUFFIX_RE.test(path) ? `${path}:${line[1]}` : path
}

function containsImage(node: MarkdownNode): boolean {
  return node.type === 'image' || (node.children ?? []).some(containsImage)
}

function nodeText(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? ''
  return (node.children ?? []).map(nodeText).join('')
}

function linkToFileButton(node: MarkdownNode): MarkdownNode | null {
  // Image links (badges) keep the default link pipeline so the image survives.
  if (containsImage(node)) return null
  const path = localLinkPath(node.url ?? '')
  if (path === null) return null
  const label = nodeText(node).trim() || path
  return { type: 'html', value: termulFilePathTag(path, label) }
}

function splitTextNode(node: MarkdownNode): MarkdownNode[] {
  const value = node.value ?? ''
  const matches = findFilePathMatches(value)
  if (matches.length === 0) return [node]

  const result: MarkdownNode[] = []
  let cursor = 0

  for (const match of matches) {
    if (match.start > cursor) {
      result.push({ type: 'text', value: value.slice(cursor, match.start) })
    }
    result.push({ type: 'html', value: termulFilePathTag(match.text) })
    cursor = match.start + match.text.length
  }

  if (cursor < value.length) {
    result.push({ type: 'text', value: value.slice(cursor) })
  }

  return result
}

function transformNode(node: MarkdownNode): MarkdownNode[] {
  if (node.type === 'text') return splitTextNode(node)
  if (node.type === 'link') {
    const button = linkToFileButton(node)
    return [button ?? node]
  }
  if (node.type === 'code' || node.type === 'html') return [node]

  if (!node.children) return [node]
  node.children = node.children.flatMap(transformNode)
  return [node]
}

/**
 * Streamdown remark plugin that turns prose path tokens into
 * `<termul-file-path data-path>` raw-HTML nodes. Unlike an href marker, the
 * custom element survives streamdown's `rehype-sanitize` (registered via the
 * `allowedTags` prop) and `rehype-harden` never sees an `a`/`img` to block.
 */
export function remarkFilePathLinks(): (tree: MarkdownNode) => void {
  return (tree) => {
    if (tree.children) tree.children = tree.children.flatMap(transformNode)
  }
}
