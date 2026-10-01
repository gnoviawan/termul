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
  children?: MarkdownNode[]
}

/** Raw HTML for a custom element the sanitizer keeps and harden ignores. */
export function termulFilePathTag(path: string): string {
  const escaped = escapeHtmlAttribute(path)
  return `<termul-file-path data-path="${escaped}">${escaped}</termul-file-path>`
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
  if (node.type === 'code' || node.type === 'link' || node.type === 'html') return [node]

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
