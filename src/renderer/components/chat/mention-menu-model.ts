/**
 * Pure helpers for the @-file mention menu. Kept free of React/store so they
 * can be unit-tested directly. Mirrors the slash-menu-model split.
 *
 * A mention token is an `@` preceded by start-of-text, whitespace, or the end
 * of a pill, plus the contiguous non-whitespace, non-`@` run after it. The
 * token is "active" while the caret sits within `(at, end]`. See ADR 0003.
 */

import { basename } from '@/lib/path-basename'
import { isComposerTriggerBoundary } from '@/lib/skill-tokens'

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
    if (!isComposerTriggerBoundary(value, i)) continue
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
  /**
   * Absolute OS path. Folder matches (`kind: 'dir'`) carry a trailing `/` — the
   * dir marker the file token reuses (see `isFolderTokenPath`) — so a folder and
   * a same-named file never share a key.
   */
  absPath: string
  name: string
  ignored: boolean
  /** Absent means `'file'` (old persisted recents and payloads). */
  kind?: 'file' | 'dir'
}

/** Folders render in their own section and never crowd out files. */
export const MAX_FOLDER_RESULTS = 20

export function isFolderMatch(m: MentionMatch): boolean {
  return m.kind === 'dir'
}

export type MentionPanel =
  | { kind: 'root' }
  | { kind: 'conversations' }
  | { kind: 'explorer'; dir: string }

export interface ConversationMatch {
  sessionId: string
  title: string
  agentName: string | null
  lastActivityAt: number
  running: boolean
}

export type MentionRow =
  | { kind: 'category'; target: 'conversations' | 'explorer' }
  | { kind: 'use-folder'; match: MentionMatch }
  | { kind: 'file'; match: MentionMatch }
  | { kind: 'dir'; match: MentionMatch }
  | { kind: 'conversation'; conversation: ConversationMatch }

export type DirListing =
  | { status: 'loading' }
  | { status: 'ready'; entries: MentionMatch[] }
  | { status: 'error' }

export interface MentionItem {
  key: string
  label: string
  description: string | null
  ignored: boolean
  row: MentionRow
}

export interface MentionSection {
  id: string
  heading?: string
  notice?: string
  items: MentionItem[]
}

export interface MentionMenuInput {
  panel: MentionPanel
  root: string
  filter: string
  matches: MentionMatch[]
  recents: MentionMatch[]
  conversations: ConversationMatch[]
  listing?: DirListing
}

export const MAX_ROOT_CONVERSATION_RESULTS = 5

export const CONVERSATIONS_EMPTY_LABEL = 'No other chats in this project yet.'
export const CONVERSATIONS_NO_MATCH_LABEL = 'No chats match. Try another title.'

export const LISTING_LOADING_LABEL = 'Loading…'
export const LISTING_ERROR_LABEL = "Couldn't list this folder"
export const LISTING_EMPTY_LABEL = 'This folder is empty'

export function relativeDir(root: string, dir: string): string {
  if (dir === root || !dir.startsWith(`${root}/`)) return ''
  return `${dir.slice(root.length + 1)}/`
}

export function folderDir(m: MentionMatch): string {
  return m.absPath.replace(/\/$/, '')
}

function matchItem(m: MentionMatch, description: string | null): MentionItem {
  return {
    key: m.absPath,
    label: m.name,
    description,
    ignored: m.ignored,
    row: isFolderMatch(m) ? { kind: 'dir', match: m } : { kind: 'file', match: m }
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

function searchSections(matches: MentionMatch[]): MentionSection[] {
  const deduped = dedupByPath(matches)
  const files = deduped.filter((m) => !isFolderMatch(m)).map((m) => matchItem(m, m.relPath))
  const folders = deduped
    .filter(isFolderMatch)
    .slice(0, MAX_FOLDER_RESULTS)
    .map((m) => matchItem(m, m.relPath))
  const sections: MentionSection[] = []
  if (files.length > 0) sections.push({ id: 'files', heading: 'Files', items: files })
  if (folders.length > 0) sections.push({ id: 'folders', heading: 'Folders', items: folders })
  return sections
}

function listingNotice(listing: DirListing | undefined): string | undefined {
  if (!listing || listing.status === 'loading') return LISTING_LOADING_LABEL
  if (listing.status === 'error') return LISTING_ERROR_LABEL
  return listing.entries.length === 0 ? LISTING_EMPTY_LABEL : undefined
}

function explorerSections(
  dir: string,
  root: string,
  recents: MentionMatch[],
  listing: DirListing | undefined
): MentionSection[] {
  const entries = listing?.status === 'ready' ? listing.entries.map((m) => matchItem(m, null)) : []
  const notice = listingNotice(listing)
  if (dir === root) {
    const sections: MentionSection[] = []
    if (recents.length > 0) {
      sections.push({
        id: 'recents',
        heading: 'Recent',
        items: recents.map((m) => matchItem(m, m.relPath))
      })
    }
    sections.push({ id: 'listing', heading: `${basename(root)}/`, notice, items: entries })
    return sections
  }
  const rel = relativeDir(root, dir)
  const folder: MentionMatch = {
    relPath: rel.replace(/\/$/, ''),
    absPath: `${dir}/`,
    name: basename(dir),
    ignored: false,
    kind: 'dir'
  }
  const useFolder: MentionItem = {
    key: `use:${folder.absPath}`,
    label: 'Use this folder',
    description: rel,
    ignored: false,
    row: { kind: 'use-folder', match: folder }
  }
  return [
    { id: 'this-folder', items: [useFolder] },
    { id: 'listing', notice, items: entries }
  ]
}

function conversationItem(c: ConversationMatch): MentionItem {
  return {
    key: `conversation:${c.sessionId}`,
    label: c.title,
    description: null,
    ignored: false,
    row: { kind: 'conversation', conversation: c }
  }
}

export function filterConversations(
  conversations: ConversationMatch[],
  filter: string
): ConversationMatch[] {
  const q = filter.trim().toLowerCase()
  if (q === '') return conversations
  return conversations.filter(
    (c) => c.title.toLowerCase().includes(q) || (c.agentName?.toLowerCase().includes(q) ?? false)
  )
}

function categorySection(root: string, conversationCount: number): MentionSection {
  return {
    id: 'categories',
    items: [
      {
        key: 'category:conversations',
        label: 'Conversations',
        description: `${conversationCount} in this project`,
        ignored: false,
        row: { kind: 'category', target: 'conversations' }
      },
      {
        key: 'category:explorer',
        label: 'Explorer',
        description: `Files and folders in ${basename(root)}/`,
        ignored: false,
        row: { kind: 'category', target: 'explorer' }
      }
    ]
  }
}

export function buildMentionSections(input: MentionMenuInput): MentionSection[] {
  const { panel, root, filter, matches, recents, conversations, listing } = input
  const searching = filter.trim() !== ''
  if (panel.kind === 'conversations') {
    const items = filterConversations(conversations, filter).map(conversationItem)
    return items.length > 0 ? [{ id: 'conversations', items }] : []
  }
  if (searching && panel.kind === 'root') {
    const hits = filterConversations(conversations, filter)
      .slice(0, MAX_ROOT_CONVERSATION_RESULTS)
      .map(conversationItem)
    const files = searchSections(matches)
    return hits.length > 0
      ? [{ id: 'conversations', heading: 'Conversations', items: hits }, ...files]
      : files
  }
  if (searching) return searchSections(matches)
  if (panel.kind === 'explorer') return explorerSections(panel.dir, root, recents, listing)
  return [categorySection(root, conversations.length)]
}

export function mentionPanelHeader(
  panel: MentionPanel,
  root: string
): { title: string; crumb: string } | null {
  if (panel.kind === 'root') return null
  if (panel.kind === 'conversations') return { title: 'Conversations', crumb: '' }
  return { title: 'Explorer', crumb: relativeDir(root, panel.dir) }
}

export interface MentionMenuView {
  panelKey: string
  header: { title: string; crumb: string } | null
  enter: 'forward' | 'back' | 'none'
  sections: MentionSection[]
  emptyLabel: string
}
