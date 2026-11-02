import { conversationToken } from '@/lib/skill-tokens'

const CLOSE_TAG = '</termul-conversation>'
const OPEN_RE = /^<termul-conversation id="([^"]*)" title="([^"]*)">\n/
const ENVELOPE_RE =
  /<termul-conversation id="[^"]*" title="[^"]*">\n[\s\S]*?\n<\/termul-conversation>/g

const ESCAPES: Record<string, string> = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }
const UNESCAPES: Record<string, string> = Object.fromEntries(
  Object.entries(ESCAPES).map(([char, entity]) => [entity, char])
)

const escapeAttr = (value: string): string => value.replace(/[&"<>]/g, (c) => ESCAPES[c] ?? c)
const unescapeAttr = (value: string): string =>
  value.replace(/&(?:amp|quot|lt|gt);/g, (e) => UNESCAPES[e] ?? e)

export interface ConversationEnvelopeRef {
  sessionId: string
  title: string
}

export function conversationEnvelope(sessionId: string, title: string, body: string): string {
  const safeBody = body.replaceAll(CLOSE_TAG, '<\\/termul-conversation>')
  return `<termul-conversation id="${escapeAttr(sessionId)}" title="${escapeAttr(title)}">\n${safeBody}\n${CLOSE_TAG}`
}

export function parseConversationEnvelope(text: string): ConversationEnvelopeRef | null {
  const open = OPEN_RE.exec(text)
  if (!open || !text.endsWith(`\n${CLOSE_TAG}`)) return null
  const sessionId = unescapeAttr(open[1] ?? '')
  const title = unescapeAttr(open[2] ?? '')
  if (sessionId.length === 0 || title.length === 0) return null
  return { sessionId, title }
}

export function stripConversationEnvelopes(text: string): string {
  return text.includes('<termul-conversation ') ? text.replace(ENVELOPE_RE, '') : text
}

// The `[termul-chat:<id>]` suffix ties the inline label to one session, so a
// restore never matches typed text or a same-title chat. The tempered title
// stops a typed `(conversation: ` earlier on the line from swallowing a label.
const LABEL_RE =
  /\(conversation: ((?:(?!\(conversation: )[^\n])+?)(, transcript unavailable)? \[termul-chat:([^\]\s]+)\]\)/g

export function conversationWireLabel(
  title: string,
  sessionId: string,
  transcriptAvailable: boolean
): string {
  const note = transcriptAvailable ? '' : ', transcript unavailable'
  return `(conversation: ${title}${note} [termul-chat:${sessionId}])`
}

export function restoreConversationLabels(text: string): string {
  if (!text.includes('[termul-chat:')) return text
  return text.replace(LABEL_RE, (_label, title: string, _note, sessionId: string) =>
    conversationToken(title, sessionId)
  )
}

export function hasConversationWire(
  blocks: ReadonlyArray<{ type: string; text?: unknown }>
): boolean {
  return blocks.some(
    (b) =>
      b.type === 'text' &&
      typeof b.text === 'string' &&
      (parseConversationEnvelope(b.text) !== null || restoreConversationLabels(b.text) !== b.text)
  )
}
