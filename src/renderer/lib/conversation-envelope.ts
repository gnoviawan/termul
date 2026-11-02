/**
 * Wire envelope for a conversation mentioned with an @ pill. Each mentioned
 * chat rides as its own `text` block so the replay path can find it, drop the
 * transcript, and restore the pill.
 */

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
  // A transcript that quotes the close tag would end the envelope early.
  const safeBody = body.replaceAll(CLOSE_TAG, '<\\/termul-conversation>')
  return `<termul-conversation id="${escapeAttr(sessionId)}" title="${escapeAttr(title)}">\n${safeBody}\n${CLOSE_TAG}`
}

/** The conversation an envelope block carries, or null when `text` is not exactly one envelope. */
export function parseConversationEnvelope(text: string): ConversationEnvelopeRef | null {
  const open = OPEN_RE.exec(text)
  if (!open || !text.endsWith(`\n${CLOSE_TAG}`)) return null
  const sessionId = unescapeAttr(open[1] ?? '')
  const title = unescapeAttr(open[2] ?? '')
  if (sessionId.length === 0 || title.length === 0) return null
  return { sessionId, title }
}

/** Remove every envelope from text that concatenates several blocks. */
export function stripConversationEnvelopes(text: string): string {
  return text.includes('<termul-conversation ') ? text.replace(ENVELOPE_RE, '') : text
}

export function hasConversationEnvelope(
  blocks: ReadonlyArray<{ type: string; text?: unknown }>
): boolean {
  return blocks.some(
    (b) =>
      b.type === 'text' && typeof b.text === 'string' && parseConversationEnvelope(b.text) !== null
  )
}
