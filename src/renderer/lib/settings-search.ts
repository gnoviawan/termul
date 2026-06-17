/**
 * Lightweight fuzzy matching for the settings search box.
 *
 * Kept dependency-free and runtime-neutral so it can be unit tested under
 * Vitest + jsdom without pulling in cmdk's React-bound command primitives.
 * The settings UI only needs to match short labels/descriptions, so a
 * subsequence matcher with simple proximity scoring is sufficient.
 */

/** A single searchable setting, flattened across all categories. */
export interface SettingsSearchEntry {
  /** Id of the category this setting belongs to. */
  categoryId: string
  /** Human-readable setting label (e.g. "Font Family"). */
  label: string
  /** Optional longer description used to broaden matches. */
  description?: string
  /** Extra search terms that should surface this setting. */
  keywords?: string[]
  /**
   * Optional DOM id to scroll to when this result is selected. When omitted,
   * selecting the result just switches to the owning category.
   */
  anchorId?: string
}

/** A scored search result. Higher score = better match. */
export interface SettingsSearchResult extends SettingsSearchEntry {
  score: number
}

/**
 * Returns whether every character of `query` appears in `text` in order
 * (case-insensitive subsequence match), plus a score. Returns `null` when
 * there is no match.
 *
 * Scoring rewards: earlier first match, consecutive matches (no gaps), and
 * matches at word boundaries — so "ff" ranks "Font Family" above an entry
 * where the letters are scattered.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()

  if (q.length === 0) return 0
  if (q.length > t.length) return null

  let score = 0
  let textIndex = 0
  let prevMatchIndex = -1

  for (let i = 0; i < q.length; i++) {
    const char = q[i]
    const found = t.indexOf(char, textIndex)
    if (found === -1) return null

    // Reward consecutive matches (adjacent characters in the text).
    if (prevMatchIndex !== -1 && found === prevMatchIndex + 1) {
      score += 6
    }

    // Reward matches at the start of a word (start of string or after a
    // separator), which strongly signals an intentional match.
    const prevChar = found > 0 ? t[found - 1] : ' '
    if (prevChar === ' ' || prevChar === '-' || prevChar === '_' || prevChar === '/') {
      score += 4
    }

    // Penalize gaps between matched characters and a late first match.
    if (prevMatchIndex !== -1) {
      score -= Math.min(found - prevMatchIndex - 1, 4)
    } else {
      score -= Math.min(found, 4)
    }

    prevMatchIndex = found
    textIndex = found + 1
  }

  return score
}

/**
 * Scores a single entry against the query by matching the label, description,
 * and keywords. Returns the best (highest) field score, with label matches
 * weighted highest. Returns `null` when nothing matches.
 */
export function scoreEntry(query: string, entry: SettingsSearchEntry): number | null {
  const q = query.trim()
  if (q.length === 0) return 0

  let best: number | null = null

  const labelScore = fuzzyScore(q, entry.label)
  if (labelScore !== null) {
    // Strong bonus so label matches outrank description/keyword matches.
    best = labelScore + 20
  }

  if (entry.description) {
    const descScore = fuzzyScore(q, entry.description)
    if (descScore !== null) {
      const weighted = descScore + 5
      best = best === null ? weighted : Math.max(best, weighted)
    }
  }

  if (entry.keywords) {
    for (const keyword of entry.keywords) {
      const keywordScore = fuzzyScore(q, keyword)
      if (keywordScore !== null) {
        const weighted = keywordScore + 10
        best = best === null ? weighted : Math.max(best, weighted)
      }
    }
  }

  return best
}

/**
 * Searches the flat settings index for `query`, returning matching entries
 * sorted by descending score. An empty/whitespace query returns `[]` so the
 * caller can fall back to the full category list.
 */
export function searchSettings(
  query: string,
  index: readonly SettingsSearchEntry[]
): SettingsSearchResult[] {
  const q = query.trim()
  if (q.length === 0) return []

  const results: SettingsSearchResult[] = []
  for (const entry of index) {
    const score = scoreEntry(q, entry)
    if (score !== null) {
      results.push({ ...entry, score })
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.label.localeCompare(b.label)
  })

  return results
}
