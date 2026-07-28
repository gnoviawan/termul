/** CSS class for inline code pills in agent chat prose. */
export type InlineCodeClass = 'chat-code-path' | 'chat-code-token'

const FILE_EXT_RE = /\.[a-z0-9]{1,6}$/i

/** True when text ends with a filename-style extension (not product names like Next.js). */
function hasFileExtension(text: string): boolean {
  const m = text.match(FILE_EXT_RE)
  if (!m) return false
  const stem = text.slice(0, -m[0].length)
  if (!stem) return false
  // CamelCase + short ext (Next.js, Node.js) — treat as token, not path.
  const ext = m[0].slice(1)
  if (/^[A-Z][a-z0-9]*$/.test(stem) && ext.length <= 3) return false
  return /^[a-z0-9][a-z0-9._-]*$/i.test(stem)
}

/**
 * Classify inline code text for pill styling.
 * Paths (slashes, backslashes, or file-extension suffix) get a distinct tint.
 */
export function inlineCodeClass(text: string): InlineCodeClass {
  const t = text.trim()
  if (t.length === 0) return 'chat-code-token'
  if (t.includes('/') || t.includes('\\')) return 'chat-code-path'
  if (hasFileExtension(t)) return 'chat-code-path'
  return 'chat-code-token'
}
