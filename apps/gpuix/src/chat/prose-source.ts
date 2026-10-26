/**
 * One prose piece as the top-level blocks the native transcript paints. Each
 * block is its own `<markdown>` so the gap between two blocks follows the web
 * stylesheet's collapsed margins (`.chat-streamdown` in index.css), which one
 * native markdown node cannot do: its block gap is a single number.
 *
 * Native markdown has no custom node renderers, so the web's remark plugins
 * become source edits here:
 *
 * - `remarkFilePathLinks`: bare file paths in text, and markdown links that
 *   point at local files, become links with the `termul-file:` scheme. The
 *   click handler opens them in the editor (same path rules as the web).
 * - stand-alone images: a paragraph holding only images is cut out of the
 *   markdown and painted by the image renderer.
 *
 * Edits use mdast source offsets, and only where the source text equals the
 * node's value, so an escaped or entity-encoded run is left as written.
 */

import type { Link, Nodes, Paragraph, Parent, RootContent, Text } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { localLinkPath } from '@/components/chat/chat-markdown-file-links'
import { findFilePathMatches } from '@/lib/file-path-match'

export type BlockKind =
  | 'paragraph'
  | 'heading'
  | 'list'
  | 'blockquote'
  | 'table'
  | 'code'
  | 'rule'
  | 'other'

export type ProseBlock =
  | {
      kind: 'markdown'
      block: BlockKind /** Heading level, else 0. */
      depth: number
      source: string
    }
  | { kind: 'image'; url: string; alt: string }

export const FILE_LINK_SCHEME = 'termul-file:'

export function fileLinkHref(path: string): string {
  return `${FILE_LINK_SCHEME}${encodeURIComponent(path)}`
}

/** The path a `termul-file:` href names, or null for any other link. */
export function fileLinkPath(href: string): string | null {
  if (!href.startsWith(FILE_LINK_SCHEME)) return null
  try {
    return decodeURIComponent(href.slice(FILE_LINK_SCHEME.length))
  } catch {
    return null
  }
}

interface Edit {
  start: number
  end: number
  text: string
}

const escapeLabel = (label: string) => label.replace(/([\\[\]])/g, '\\$1')

function span(node: Nodes): [number, number] | null {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return start === undefined || end === undefined ? null : [start, end]
}

function containsImage(node: Nodes): boolean {
  if (node.type === 'image' || node.type === 'imageReference') return true
  return 'children' in node && (node.children as Nodes[]).some(containsImage)
}

function textEdits(source: string, node: Text, edits: Edit[]): void {
  const at = span(node)
  if (!at || source.slice(at[0], at[1]) !== node.value) return
  for (const match of findFilePathMatches(node.value)) {
    const start = at[0] + match.start
    edits.push({
      start,
      end: start + match.text.length,
      text: `[${escapeLabel(match.text)}](${fileLinkHref(match.text)})`
    })
  }
}

function linkEdit(source: string, node: Link, edits: Edit[]): void {
  if (containsImage(node)) return
  const path = localLinkPath(node.url)
  const at = span(node)
  if (path === null || !at) return
  const first = node.children[0] && span(node.children[0])
  const last = node.children.at(-1) && span(node.children.at(-1) as Nodes)
  const label = first && last ? source.slice(first[0], last[1]) : escapeLabel(path)
  edits.push({ start: at[0], end: at[1], text: `[${label}](${fileLinkHref(path)})` })
}

function walk(source: string, node: Nodes, edits: Edit[]): void {
  if (node.type === 'text') {
    textEdits(source, node, edits)
    return
  }
  if (node.type === 'link') {
    linkEdit(source, node, edits)
    return
  }
  if (node.type === 'linkReference' || node.type === 'inlineCode' || node.type === 'code') return
  if (node.type === 'html' || node.type === 'definition') return
  if ('children' in node)
    for (const child of (node as Parent).children) walk(source, child as Nodes, edits)
}

/** A paragraph that is only images (whitespace between them allowed). */
function imageParagraph(node: RootContent): { url: string; alt: string }[] | null {
  if (node.type !== 'paragraph') return null
  const images: { url: string; alt: string }[] = []
  for (const child of (node as Paragraph).children) {
    if (child.type === 'image') images.push({ url: child.url, alt: child.alt ?? '' })
    else if (!(child.type === 'text' && !child.value.trim())) return null
  }
  return images.length ? images : null
}

function blockKind(node: RootContent): BlockKind {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'list':
    case 'blockquote':
    case 'table':
    case 'code':
      return node.type
    case 'thematicBreak':
      return 'rule'
    default:
      return 'other'
  }
}

/**
 * Nested GFM task items: native markdown prints `[x]` literally, so the
 * marker becomes a ballot box glyph. A top-level item keeps its marker: the
 * transcript paints it as a checkbox (`TaskItem`).
 */
function taskEdits(source: string, node: Nodes, edits: Edit[], depth = 0): void {
  if (node.type === 'listItem' && depth > 1 && typeof node.checked === 'boolean') {
    const at = span(node)
    if (at) {
      const match = /^([-*+]|\d+[.)])[ \t]+\[[ xX]\]/.exec(source.slice(at[0], at[1]))
      if (match) {
        const box = node.checked ? '\u2611' : '\u2610'
        edits.push({ start: at[0], end: at[0] + match[0].length, text: `${match[1]} ${box}` })
      }
    }
  }
  const inner = node.type === 'list' ? depth + 1 : depth
  if ('children' in node)
    for (const child of (node as Parent).children) taskEdits(source, child as Nodes, edits, inner)
}

function applyEdits(source: string, start: number, end: number, edits: Edit[]): string {
  let out = ''
  let cursor = start
  for (const edit of edits) {
    if (edit.start < cursor || edit.end > end) continue
    out += source.slice(cursor, edit.start) + edit.text
    cursor = edit.end
  }
  return out + source.slice(cursor, end)
}

const cache = new Map<string, ProseBlock[]>()
const CACHE_LIMIT = 512

/**
 * The blocks of one prose piece; `linkFiles` mirrors the web's
 * `filePathContext` gate. Link reference definitions stay attached to every
 * block so a `[label][ref]` resolves in whichever block uses it.
 */
export function proseBlocks(source: string, linkFiles: boolean): ProseBlock[] {
  const cacheKey = `${linkFiles ? 1 : 0}${source}`
  const hit = cache.get(cacheKey)
  if (hit) return hit

  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const mayLink = linkFiles && /[/\\:]/.test(source)
  const definitions = tree.children
    .filter((child) => child.type === 'definition')
    .map((child) => {
      const at = span(child)
      return at ? source.slice(at[0], at[1]) : ''
    })
    .filter(Boolean)
    .join('\n')
  const blocks: ProseBlock[] = []
  for (const child of tree.children) {
    const at = span(child)
    if (!at || child.type === 'definition') continue
    const images = imageParagraph(child)
    if (images) {
      for (const image of images) blocks.push({ kind: 'image', ...image })
      continue
    }
    const edits: Edit[] = []
    if (child.type === 'list') taskEdits(source, child, edits)
    if (mayLink) walk(source, child, edits)
    edits.sort((a, b) => a.start - b.start)
    const text = applyEdits(source, at[0], at[1], edits)
    blocks.push({
      kind: 'markdown',
      block: blockKind(child),
      depth: child.type === 'heading' ? child.depth : 0,
      source: definitions && text.includes(']') ? `${text}\n\n${definitions}` : text
    })
  }

  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(cacheKey, blocks)
  return blocks
}

const TASK = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?:[ \t]+|$)/

export interface TaskMarker {
  /** `-`, `*`, `+`, or an ordered marker such as `3.` */
  marker: string
  checked: boolean
  /** The item's text and any continuation lines, without the marker. */
  body: string
}

/** The task marker of one list item's source (`listItems`), or null for a plain item. */
export function taskMarker(item: string): TaskMarker | null {
  const match = TASK.exec(item)
  if (!match) return null
  const rest = item.slice(match[0].length)
  const body = rest
    .split('\n')
    .map((line, i) => (i === 0 ? line : line.replace(/^ {1,4}/, '')))
    .join('\n')
  return { marker: match[2], checked: match[3] !== ' ', body }
}

/** A quote block's content: its lines with the leading `>` marker removed. */
export function unquote(source: string): string {
  return source
    .split('\n')
    .map((line) => line.replace(/^ {0,3}> ?/, ''))
    .join('\n')
}

const ORDERED_MARKER = /^ {0,3}\d{1,9}([.)])[ \t]+/

/**
 * An ordered item whose content is one paragraph, as a paragraph that starts
 * with its number. Streamdown's lists are `list-inside`: the marker is inline
 * text, the content follows it at the width of "1. ", and wrapped lines start
 * at the item's left edge. Native markdown sets a marker column instead.
 * Null for any other item, which keeps the native list.
 */
export function inlineOrderedItem(item: string): string | null {
  const marker = ORDERED_MARKER.exec(item)
  if (!marker) return null
  const list = fromMarkdown(item, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
    .children[0]
  if (list?.type !== 'list' || !list.ordered || list.children.length !== 1) return null
  const blocks = list.children[0]?.children ?? []
  if (blocks.length !== 1 || blocks[0]?.type !== 'paragraph') return null
  return `${list.start ?? 1}\\${marker[1]} ${item.slice(marker[0].length)}`
}

/**
 * A list block's top-level items, each as list source of its own. Native
 * markdown spaces list items a fixed 4px apart; Streamdown's `li` is `py-1`
 * (8px between items), so each item paints as its own element. An ordered
 * item keeps its number by starting its own list there.
 */
export function listItems(source: string): string[] {
  const list = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
    .children[0]
  if (list?.type !== 'list' || list.children.length < 2) return [source]
  const lineStart = (offset: number) => source.lastIndexOf('\n', offset - 1) + 1
  const starts = list.children.map((item) => lineStart(item.position?.start.offset ?? 0))
  return starts.map((start, i) => {
    const item = source.slice(start, starts[i + 1] ?? source.length).replace(/\n+$/, '')
    return list.ordered && i > 0
      ? item.replace(/^( {0,3})\d{1,9}/, `$1${(list.start ?? 1) + i}`)
      : item
  })
}
