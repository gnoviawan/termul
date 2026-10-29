/**
 * Selection context: text the user selected in a chat message and added to
 * the composer as an inline chip. This module owns the whole token model and
 * the prompt format; the UI only creates contexts and renders chips.
 *
 * ## Display-string token
 *
 * `\uE008[<language>\u001F]<payload>\uE009`. The `<language>` part is present
 * only for code (it may be empty for code with no language). The payload is
 * the URI-encoded text, so the token has no whitespace, `/`, `@`, or sentinel
 * inside it and the composer's slash/mention scanners skip it.
 *
 * ## Prompt format (sent to every ACP agent)
 *
 * When the composer has one or more contexts, the prompt text starts with one
 * labeled quote block per context, numbered by chip order. Each chip becomes a
 * `[Context N]` marker at its position in the user's sentence:
 *
 * ```text
 * Context 1 (selected from the conversation):
 * > first quoted line
 * >
 * > third quoted line
 *
 * Context 2 (selected from the conversation):
 * > ```ts
 * > const x = 1
 * > ```
 *
 * Compare [Context 1] with [Context 2]
 * ```
 *
 * - Every quoted line starts with `> ` (an empty line is a bare `>`).
 * - Code keeps its language in a fenced block. The fence is longer than any
 *   backtick run in the code.
 * - The sentence is trimmed. A marker the user typed as text is escaped with
 *   one more leading backslash (`[Context 1]` -> `\[Context 1]`).
 * - A leading slash command stays first (`/review` + blank line + blocks) so
 *   the agent still runs it.
 * - With no context, the value passes through unchanged, except that typed
 *   markers are escaped when the text contains the label, so it can never be
 *   restored as a prompt with chips.
 *
 * {@link selectionContextsToDisplay} is the exact inverse, used to show chips
 * again when a chat is restored from the wire record.
 */
import {
  CMD_TOKEN_END,
  CMD_TOKEN_START,
  CONTEXT_TOKEN_END,
  CONTEXT_TOKEN_SEP,
  CONTEXT_TOKEN_START,
  commandToken,
  replaceSkillTokensInline
} from '@/lib/skill-tokens'

export interface SelectionContext {
  text: string
  /** Set (possibly to `''`) only for code. */
  language?: string
}

export type SelectionContextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'context'; context: SelectionContext }

const LABEL_SUFFIX = ' (selected from the conversation):'
const SENTINEL_RE = /[\uE000-\uE00F]/g
const LANGUAGE_STRIP_RE = /[^\w+#.-]/g
const FENCE_LINE_RE = /^(`{3,})([\w+#.-]*)$/
const MARKER_RE = /(\\*)\[Context (\d+)\]/g
const ANY_TOKEN_RE =
  /[\uE000\uE002\uE004\uE006\uE008][^\uE001\uE003\uE005\uE007\uE009]*[\uE001\uE003\uE005\uE007\uE009]/g

export function selectionContextLabel(index: number): string {
  return `Context ${index}`
}

/**
 * Normalize raw selected text. Returns null when nothing is left. A prose
 * selection that is exactly one fenced block becomes code, so the prompt
 * reverse can never mistake prose for code.
 */
export function createSelectionContext(raw: string, language?: string): SelectionContext | null {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(SENTINEL_RE, '')
    .replaceAll(CONTEXT_TOKEN_SEP, '')
  if (language === undefined) {
    const trimmed = text.trim()
    if (trimmed.length === 0) return null
    return parseFencedBlock(trimmed) ?? { text: trimmed }
  }
  const body = text.replace(/^(?:[ \t]*\n)+/, '').trimEnd()
  if (body.trim().length === 0) return null
  const lang = language.replace(LANGUAGE_STRIP_RE, '')
  return { text: body, language: lang === 'text' ? '' : lang }
}

/** Tiptap node attrs for a context pill. `language` is null for prose. */
export function contextToAttrs(context: SelectionContext): {
  text: string
  language: string | null
} {
  return { text: context.text, language: context.language ?? null }
}

export function contextFromAttrs(attrs: Record<string, unknown>): SelectionContext {
  const text = String(attrs.text ?? '')
  return typeof attrs.language === 'string' ? { text, language: attrs.language } : { text }
}

export function selectionContextToken(context: SelectionContext): string {
  const payload = encodeURIComponent(context.text)
  const head = context.language === undefined ? '' : `${context.language}${CONTEXT_TOKEN_SEP}`
  return `${CONTEXT_TOKEN_START}${head}${payload}${CONTEXT_TOKEN_END}`
}

function decodeToken(inner: string): SelectionContext | null {
  const sep = inner.indexOf(CONTEXT_TOKEN_SEP)
  const payload = sep === -1 ? inner : inner.slice(sep + 1)
  let text: string
  try {
    text = decodeURIComponent(payload)
  } catch {
    return null
  }
  if (text.length === 0) return null
  return sep === -1 ? { text } : { text, language: inner.slice(0, sep) }
}

/** Split a display string into text runs and contexts. Malformed tokens stay text. */
export function parseSelectionContextSegments(value: string): SelectionContextSegment[] {
  const segments: SelectionContextSegment[] = []
  let text = ''
  let i = 0
  while (i < value.length) {
    const start = value.indexOf(CONTEXT_TOKEN_START, i)
    if (start === -1) {
      text += value.slice(i)
      break
    }
    text += value.slice(i, start)
    const end = value.indexOf(CONTEXT_TOKEN_END, start + 1)
    if (end === -1) {
      text += value.slice(start)
      break
    }
    const context = decodeToken(value.slice(start + 1, end))
    if (context === null) {
      text += value.slice(start, end + 1)
    } else {
      if (text.length > 0) segments.push({ kind: 'text', text })
      text = ''
      segments.push({ kind: 'context', context })
    }
    i = end + 1
  }
  if (text.length > 0) segments.push({ kind: 'text', text })
  return segments
}

export function hasSelectionContexts(value: string): boolean {
  return parseSelectionContextSegments(value).some((s) => s.kind === 'context')
}

/** Replace each context with its `[Context N]` marker (one-line surfaces: titles, queue rows). */
export function replaceSelectionContextsWithMarkers(value: string): string {
  let n = 0
  return parseSelectionContextSegments(value)
    .map((s) => (s.kind === 'context' ? `[${selectionContextLabel(++n)}]` : s.text))
    .join('')
}

/** One-line preview: whitespace collapsed, cut to `max` characters with an ellipsis. */
export function selectionContextPreview(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = Array.from(flat)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat
}

function fenceFor(code: string): string {
  let longest = 0
  for (const run of code.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

function parseFencedBlock(text: string): SelectionContext | null {
  const lines = text.split('\n')
  if (lines.length < 3) return null
  const open = FENCE_LINE_RE.exec(lines[0])
  if (!open || lines[lines.length - 1] !== open[1]) return null
  const inner = lines.slice(1, -1).join('\n')
  return inner.trim().length > 0 ? { text: inner, language: open[2] } : null
}

function quoteBlock(context: SelectionContext, index: number): string {
  const body =
    context.language === undefined
      ? context.text
      : `${fenceFor(context.text)}${context.language}\n${context.text}\n${fenceFor(context.text)}`
  const quoted = body
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n')
  return `${selectionContextLabel(index)}${LABEL_SUFFIX}\n${quoted}`
}

/** Add one backslash before each typed `[Context N]`, outside other pill tokens. */
function escapeTypedMarkers(text: string): string {
  let out = ''
  let last = 0
  for (const match of text.matchAll(ANY_TOKEN_RE)) {
    out += text.slice(last, match.index).replace(MARKER_RE, '\\$1[Context $2]') + match[0]
    last = match.index + match[0].length
  }
  return out + text.slice(last).replace(MARKER_RE, '\\$1[Context $2]')
}

/**
 * Build the prompt text from a display string (see the module doc for the
 * format). Other pill tokens are kept for the later wire steps.
 */
export function serializeSelectionContexts(value: string): string {
  const segments = parseSelectionContextSegments(value)
  const contexts: SelectionContext[] = []
  let sentence = ''
  for (const seg of segments) {
    if (seg.kind === 'text') {
      sentence += escapeTypedMarkers(seg.text)
    } else {
      contexts.push(seg.context)
      sentence += `[${selectionContextLabel(contexts.length)}]`
    }
  }
  // No chip: typed markers next to a typed label are escaped, so the restore
  // can never read the text as a real prompt.
  if (contexts.length === 0) return value.includes(LABEL_SUFFIX) ? escapeTypedMarkers(value) : value
  sentence = sentence.trim()
  const preamble = contexts.map((c, i) => quoteBlock(c, i + 1)).join('\n\n')
  if (sentence.startsWith(CMD_TOKEN_START)) {
    const end = sentence.indexOf(CMD_TOKEN_END)
    if (end !== -1) {
      const command = sentence.slice(0, end + 1)
      return `${command}\n\n${preamble}\n\n${sentence.slice(end + 1).trimStart()}`
    }
  }
  return `${preamble}\n\n${sentence}`
}

function decodeQuotedBody(lines: string[]): SelectionContext {
  const body = lines.join('\n')
  const fenced = parseFencedBlock(body)
  const context = fenced ?? { text: body }
  // The skill reverse may have turned a `(name)` inside the quote into a skill token.
  return { ...context, text: replaceSkillTokensInline(context.text) }
}

/**
 * Inverse of {@link serializeSelectionContexts} for restored chats. Returns
 * the display string with context tokens. Text with the label that is not an
 * exact prompt only gets the typed-marker escape undone.
 */
export function selectionContextsToDisplay(text: string): string {
  if (!text.includes(LABEL_SUFFIX)) return text
  return promptToDisplay(text) ?? text.replace(MARKER_RE, unescapeMarker)
}

function unescapeMarker(marker: string, slashes: string, n: string): string {
  return slashes.length > 0 ? `${slashes.slice(1)}[Context ${n}]` : marker
}

function promptToDisplay(text: string): string | null {
  let prefix = ''
  let rest = text
  const command = /^\/(\S+)\n\n/.exec(rest)
  if (
    command &&
    rest.slice(command[0].length).startsWith(`${selectionContextLabel(1)}${LABEL_SUFFIX}\n`)
  ) {
    prefix = `${commandToken(command[1])} `
    rest = rest.slice(command[0].length)
  }
  const lines = rest.split('\n')
  const contexts: SelectionContext[] = []
  let i = 0
  while (lines[i] === `${selectionContextLabel(contexts.length + 1)}${LABEL_SUFFIX}`) {
    i += 1
    const quoted: string[] = []
    while (i < lines.length && (lines[i] === '>' || lines[i].startsWith('> '))) {
      quoted.push(lines[i].slice(2))
      i += 1
    }
    if (quoted.length === 0 || lines[i] !== '') return null
    i += 1
    contexts.push(decodeQuotedBody(quoted))
  }
  if (contexts.length === 0) return null
  const sentence = lines.slice(i).join('\n')
  let next = 1
  let valid = true
  const display = sentence.replace(MARKER_RE, (_marker, slashes: string, n: string) => {
    if (slashes.length > 0) return unescapeMarker(_marker, slashes, n)
    if (Number(n) !== next || next > contexts.length) {
      valid = false
      return _marker
    }
    next += 1
    return selectionContextToken(contexts[Number(n) - 1])
  })
  if (!valid || next !== contexts.length + 1) return null
  return `${prefix}${display}`
}
