import { splitFrontmatter } from '@/lib/markdown-frontmatter'

export const WORDS_PER_MINUTE = 200

export interface DocumentStats {
  words: number
  minutes: number
}

/** Fenced code blocks (open fence to matching close fence or end of text). */
const FENCED_BLOCK = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm
const MARKDOWN_PUNCTUATION = /[#>*_`~|[\]()!-]+/g
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu

/** Word count and read time (200 wpm, at least 1 min) for markdown prose. Code fences do not count. */
export function getDocumentStats(markdown: string): DocumentStats {
  const { body } = splitFrontmatter(markdown)
  const text = body.replace(FENCED_BLOCK, ' ').replace(MARKDOWN_PUNCTUATION, ' ')
  const words = text.match(WORD)?.length ?? 0
  return { words, minutes: Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)) }
}

export function formatDocumentStats({ words, minutes }: DocumentStats): string {
  const wordLabel = `${words.toLocaleString('en-US')} ${words === 1 ? 'word' : 'words'}`
  return `${wordLabel} · ${minutes} min read`
}
