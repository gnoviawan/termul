/**
 * Pure helpers for the @-file mention menu. Kept free of React/store so they
 * can be unit-tested directly. Mirrors the slash-menu-model split.
 *
 * A mention token is an `@` preceded by start-of-text or whitespace, plus the
 * contiguous non-whitespace, non-`@` run after it. The token is "active" while
 * the caret sits within `(at, end]`. See ADR 0003.
 */

import { runtimeT } from '@/i18n/runtime'

export interface MentionToken {
  /** Index of the `@` in the composer value. */
  at: number
  /** Exclusive end of the @word (one past the last token char). */
  end: number
  /** The text after `@` up to `end` (may be empty for a bare `@`). */
  query: string
}

function isTokenChar(c: string): boolean {
  return !/\s/.test(c) && c !== '@'
}

/**
 * Find the active @mention token at the given caret, or null. When several
 * `@` chars precede the caret, the nearest one that forms a valid token wins.
 */
export function activeMentionToken(value: string, caret: number): MentionToken | null {
  if (caret < 0 || caret > value.length) return null
  for (let i = caret - 1; i >= 0; i--) {
    if (value[i] !== '@') continue
    const prev = i === 0 ? '' : value[i - 1]
    if (prev !== '' && !/\s/.test(prev)) continue
    let end = i + 1
    while (end < value.length && isTokenChar(value[end])) end++
    if (caret > i && caret <= end) {
      return { at: i, end, query: value.slice(i + 1, end) }
    }
  }
  return null
}

/** True when an active @mention token sits at the caret. */
export function isMentionTrigger(value: string, caret: number): boolean {
  return activeMentionToken(value, caret) !== null
}

/** Remove the @token from the value (the caller moves the caret to `token.at`). */
export function spliceMentionToken(value: string, token: MentionToken): string {
  return value.slice(0, token.at) + value.slice(token.end)
}

// ----- Section building ----------------------------------------------------

/**
 * A resolved file-mention candidate. `relPath`/`name` are display fields;
 * `absPath` is the absolute OS path used to build the `resource_link` URI.
 * Constructed by the composer hook from a `SearchFileHit` + the search root.
 */
export interface MentionMatch {
  relPath: string
  absPath: string
  name: string
  ignored: boolean
}

export interface MentionItem {
  key: string
  label: string
  description: string
  ignored: boolean
  payload: MentionMatch
}

export interface MentionSection {
  id: string
  heading: string
  items: MentionItem[]
}

function toMentionItem(m: MentionMatch): MentionItem {
  return {
    key: m.absPath,
    label: m.name,
    description: m.relPath,
    ignored: m.ignored,
    payload: m
  }
}

function dedupByPath(matches: MentionMatch[]): MentionMatch[] {
  const seen = new Set<string>()
  const out: MentionMatch[] = []
  for (const m of matches) {
    if (seen.has(m.absPath)) continue
    seen.add(m.absPath)
    out.push(m)
  }
  return out
}

/**
 * Build picker sections from live matches + recents. Per ADR 0003: an empty
 * query shows Recents; a non-empty query shows Files (the ripgrep results,
 * already ranked non-ignored-first by the backend). Returns no sections when
 * there is nothing to show so the menu can render its empty state.
 */
export function buildMentionSections(input: {
  matches: MentionMatch[]
  recents: MentionMatch[]
  filter: string
}): MentionSection[] {
  const { matches, recents, filter } = input
  if (filter.trim() === '') {
    const items = recents.map(toMentionItem)
    if (items.length === 0) return []
    return [{ id: 'recents', heading: runtimeT('chat', 'mention.recent', 'Recent'), items }]
  }
  const items = dedupByPath(matches).map(toMentionItem)
  if (items.length === 0) return []
  return [{ id: 'files', heading: runtimeT('chat', 'mention.files', 'Files'), items }]
}
