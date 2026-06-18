export interface WordDiffSegment {
  text: string
  type: 'common' | 'added' | 'removed'
}

interface Token {
  text: string
  index: number
}

function tokenizeWords(text: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < text.length) {
    const start = i
    const char = text[i]

    if (char === ' ' || char === '\t') {
      while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
        i += 1
      }
    } else if (isWordChar(char)) {
      while (i < text.length && isWordChar(text[i])) {
        i += 1
      }
    } else {
      i += 1
    }

    tokens.push({ text: text.slice(start, i), index: tokens.length })
  }
  return tokens
}

function isWordChar(char: string): boolean {
  return /[a-zA-Z0-9_]/.test(char)
}

const MAX_WORD_TOKENS = 500

/**
 * Compute word-level diff between two text strings using LCS algorithm.
 * Returns segments marked as 'common', 'added', or 'removed'.
 * Falls back to a simple removed+added for very long lines (O(n*m) guard).
 */
export function computeWordDiff(oldText: string, newText: string): WordDiffSegment[] {
  if (oldText === newText) {
    return [{ text: oldText, type: 'common' }]
  }

  if (!oldText) {
    return [{ text: newText, type: 'added' }]
  }

  if (!newText) {
    return [{ text: oldText, type: 'removed' }]
  }

  const oldTokens = tokenizeWords(oldText)
  const newTokens = tokenizeWords(newText)

  // Guard against O(n*m) blowup on very long lines
  if (oldTokens.length > MAX_WORD_TOKENS || newTokens.length > MAX_WORD_TOKENS) {
    return [
      { text: oldText, type: 'removed' },
      { text: newText, type: 'added' }
    ]
  }

  const oldLen = oldTokens.length
  const newLen = newTokens.length

  // Build LCS table
  const lcs: number[][] = Array.from({ length: oldLen + 1 }, () => new Array(newLen + 1).fill(0))

  for (let i = oldLen - 1; i >= 0; i -= 1) {
    for (let j = newLen - 1; j >= 0; j -= 1) {
      if (oldTokens[i].text === newTokens[j].text) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1])
      }
    }
  }

  // Backtrack to build segments
  const segments: WordDiffSegment[] = []
  let i = 0
  let j = 0

  while (i < oldLen && j < newLen) {
    if (oldTokens[i].text === newTokens[j].text) {
      appendSegment(segments, oldTokens[i].text, 'common')
      i += 1
      j += 1
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      appendSegment(segments, oldTokens[i].text, 'removed')
      i += 1
    } else {
      appendSegment(segments, newTokens[j].text, 'added')
      j += 1
    }
  }

  while (i < oldLen) {
    appendSegment(segments, oldTokens[i].text, 'removed')
    i += 1
  }

  while (j < newLen) {
    appendSegment(segments, newTokens[j].text, 'added')
    j += 1
  }

  return segments
}

function appendSegment(
  segments: WordDiffSegment[],
  text: string,
  type: WordDiffSegment['type']
): void {
  const last = segments[segments.length - 1]
  if (last && last.type === type) {
    last.text += text
  } else {
    segments.push({ text, type })
  }
}

/**
 * Given word-diff segments, return the character ranges that are "changed"
 * (i.e., removed or added) relative to a given side.
 * For deletion lines, pass type='removed' to get removed ranges.
 * For addition lines, pass type='added' to get added ranges.
 */
export function getChangedRanges(
  segments: WordDiffSegment[],
  side: 'removed' | 'added'
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  let pos = 0

  for (const seg of segments) {
    const segLen = seg.text.length
    if (seg.type === side) {
      ranges.push({ start: pos, end: pos + segLen })
    }
    pos += segLen
  }

  return ranges
}
