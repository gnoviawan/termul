import { code as shikiCodePlugin } from '@streamdown/code'
import type { CodeHighlighterPlugin } from 'streamdown'

/** Languages that carry no grammar: highlighting them only tokenizes and caches. */
const PLAIN_TEXT_LANGUAGES = new Set(['text', 'txt', 'plain', 'plaintext'])

/**
 * Shiki code plugin for chat fences, with one change: plain-text blocks skip
 * the highlighter and render Streamdown's unhighlighted fallback. `ChatMarkdownCode`
 * hands an open, oversized fence to Streamdown as `text` so the stream does not
 * re-tokenize (and cache) the whole growing fence on every commit; the real
 * language is applied once the fence closes.
 */
export const chatCodePlugin: CodeHighlighterPlugin = {
  ...shikiCodePlugin,
  highlight(options, callback) {
    if (PLAIN_TEXT_LANGUAGES.has(options.language.trim().toLowerCase())) return null
    return shikiCodePlugin.highlight(options, callback)
  }
}
