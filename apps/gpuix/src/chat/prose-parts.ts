/**
 * An agent reply as the parts the native transcript paints: prose pieces for
 * `<markdown>`, top-level fences for the code card (or its mermaid and plan
 * renderers), and stand-alone images. Each part keeps its key while the reply
 * streams, because the split is prefix-stable: appending text only grows the
 * last part or starts a new one, so the settled parts never re-render.
 *
 * The fence split and the bounded prose pieces follow kybern's
 * `transcript/markdown.tsx` (`markdownParts`, `textChunks`; MIT, see
 * THIRD_PARTY_NOTICES.md), rewritten for Termul's parts.
 */

export type FencePart = {
  kind: 'fence'
  key: string
  /** The info string's first word, lower-cased (`ts`, `mermaid`, `termul-plan`). */
  language: string
  code: string
  /** The closing fence has not arrived: the reply is still streaming it. */
  open: boolean
}

export type ProsePiece = { kind: 'prose'; key: string; source: string }

export type ProsePart = FencePart | ProsePiece

/** A top-level fence opener: up to three spaces, then three or more backticks or tildes. */
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/
/** A list item or an indented continuation line: an indented fence after one belongs to it. */
const LIST_CONTEXT = /^(\s+\S|\s*([-*+]|\d+[.)])\s)/

function inListContext(prose: readonly string[]): boolean {
  for (let i = prose.length - 1; i >= 0; i--) {
    if (prose[i].trim()) return LIST_CONTEXT.test(prose[i])
  }
  return false
}

interface Segment {
  kind: 'prose' | 'fence'
  lines: string[]
  language: string
  open: boolean
}

/** Top-level fences only; a fence nested in a list or quote stays in its prose piece. */
function segments(text: string): Segment[] {
  const out: Segment[] = []
  let prose: string[] = []
  let fence: { marker: string; segment: Segment } | null = null
  const flushProse = () => {
    if (prose.some((line) => line.trim())) {
      out.push({ kind: 'prose', lines: prose, language: '', open: false })
    }
    prose = []
  }
  for (const line of text.split('\n')) {
    if (fence) {
      const close = FENCE_OPEN.exec(line)
      const closes =
        close !== null &&
        close[2][0] === fence.marker[0] &&
        close[2].length >= fence.marker.length &&
        close[3].trim() === ''
      if (closes) {
        fence.segment.open = false
        fence = null
      } else {
        fence.segment.lines.push(line)
      }
      continue
    }
    const open = FENCE_OPEN.exec(line)
    // A backtick fence whose info string holds a backtick is inline code, not a fence.
    const isFence = open !== null && !(open[2][0] === '`' && open[3].includes('`'))
    if (isFence && !(open[1].length > 0 && inListContext(prose))) {
      flushProse()
      const segment: Segment = {
        kind: 'fence',
        lines: [],
        language: (open[3].trim().split(/\s+/)[0] ?? '').toLowerCase(),
        open: true
      }
      out.push(segment)
      fence = { marker: open[2], segment }
      continue
    }
    prose.push(line)
  }
  flushProse()
  return out
}

/** A piece aims for this many lines or characters, then ends at the next block boundary. */
const PIECE_LINES = 40
const PIECE_CHARS = 6000
/** Past this a piece ends at the next line, block or not (one giant list or table). */
const HARD_LINES = PIECE_LINES * 8
const NESTED_FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/

/**
 * Prose in pieces that are each a run of whole blocks. A piece ends only before
 * a column-0 line that follows a blank line, outside any nested fence, so a
 * table, paragraph or list item is never cut. The decision for a line depends
 * only on the lines before it, so an earlier cut never moves as text streams.
 */
export function proseChunks(lines: readonly string[]): string[] {
  const out: string[] = []
  let first = 0
  let chars = 0
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const size = i - first
    const boundary = fence === null && i > first && !lines[i - 1].trim() && /^\S/.test(line)
    if ((boundary && (size >= PIECE_LINES || chars >= PIECE_CHARS)) || size >= HARD_LINES) {
      out.push(lines.slice(first, i).join('\n'))
      first = i
      chars = 0
    }
    const marker = NESTED_FENCE.exec(line)
    if (fence !== null) {
      if (
        marker &&
        marker[2][0] === fence[0] &&
        marker[2].length >= fence.length &&
        !marker[3].trim()
      ) {
        fence = null
      }
    } else if (marker && !(marker[2][0] === '`' && marker[3].includes('`'))) {
      fence = marker[2]
    }
    chars += line.length + 1
  }
  out.push(lines.slice(first).join('\n'))
  return out.map((piece) => piece.replace(/^\n+|\n+$/g, '')).filter((piece) => piece !== '')
}

const cache = new Map<string, ProsePart[]>()
const CACHE_LIMIT = 128
const CACHEABLE_CHARS = 64 * 1024

/** The parts of one reply. Keys are positional, so they survive streaming. */
export function proseParts(text: string): ProsePart[] {
  const hit = cache.get(text)
  if (hit) return hit
  const parts: ProsePart[] = []
  segments(text).forEach((segment, s) => {
    if (segment.kind === 'fence') {
      parts.push({
        kind: 'fence',
        key: `${s}`,
        language: segment.language,
        code: segment.lines.join('\n'),
        open: segment.open
      })
      return
    }
    proseChunks(segment.lines).forEach((source, p) => {
      parts.push({ kind: 'prose', key: `${s}.${p}`, source })
    })
  })
  if (text.length <= CACHEABLE_CHARS) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
    cache.set(text, parts)
  }
  return parts
}
