import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({
  gfm: true,
  breaks: true
})

/**
 * Render agent message markdown to sanitized HTML for `dangerouslySetInnerHTML`.
 *
 * Streaming-safe: callers pass the coalesced text so far; partial markdown
 * still renders cleanly. Output is sanitized with DOMPurify to strip any
 * scripts/handlers an agent might emit.
 */
export function renderChatMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true }
  })
}
