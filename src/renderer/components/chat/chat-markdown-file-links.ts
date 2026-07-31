import { findFilePathMatches } from '@/lib/file-path-links'

export const FILE_PATH_LINK_PREFIX = 'termul-file-path:'

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  title?: string | null
  children?: MarkdownNode[]
}

export function filePathHref(path: string): string {
  return `${FILE_PATH_LINK_PREFIX}${encodeURIComponent(path)}`
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
    result.push({
      type: 'link',
      title: null,
      url: filePathHref(match.text),
      children: [{ type: 'text', value: match.text }]
    })
    cursor = match.start + match.text.length
  }

  if (cursor < value.length) {
    result.push({ type: 'text', value: value.slice(cursor) })
  }

  return result
}

function transformNode(node: MarkdownNode): MarkdownNode[] {
  if (node.type === 'text') return splitTextNode(node)
  if (node.type === 'code' || node.type === 'link') return [node]

  if (node.type === 'inlineCode') {
    const value = node.value ?? ''
    const matches = findFilePathMatches(value)
    if (matches.length === 1 && matches[0]?.start === 0 && matches[0].text === value) {
      return [{ type: 'link', title: null, url: filePathHref(value), children: [node] }]
    }
    return [node]
  }

  if (!node.children) return [node]
  node.children = node.children.flatMap(transformNode)
  return [node]
}

/** Streamdown remark plugin that turns prose path tokens into marker links. */
export function remarkFilePathLinks(): (tree: MarkdownNode) => void {
  return (tree) => {
    if (tree.children) tree.children = tree.children.flatMap(transformNode)
  }
}

export function filePathFromHref(href: string | undefined): string | null {
  if (!href?.startsWith(FILE_PATH_LINK_PREFIX)) return null
  try {
    return decodeURIComponent(href.slice(FILE_PATH_LINK_PREFIX.length))
  } catch {
    return null
  }
}
