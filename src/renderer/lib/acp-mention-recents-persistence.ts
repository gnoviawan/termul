/**
 * Persistence for recently-@-mentioned files, partitioned by `(projectId, cwd)`
 * — the same partitioning as Agent Chat history (ADR 0002). See ADR 0003.
 *
 * Recents are stored as `{ relPath, name, ignored }` (not absolute paths) so
 * they survive a worktree path moving within a project; the absolute path is
 * rebuilt on load from the active `cwd`.
 */

import type { MentionMatch } from '@/components/chat/mention-menu-model'
import { persistenceApi } from '@/lib/api'

export const ACP_MENTION_RECENTS_KEY = 'acp/mention-recents'
export const MENTION_RECENTS_CAP = 20

export interface StoredRecent {
  relPath: string
  name: string
  ignored: boolean
}

/** Composite key isolates a project's main checkout from its worktrees. */
export function compositeKey(projectId: string, cwd: string): string {
  return `${projectId}\u0000${cwd}`
}

export function toStoredRecent(match: MentionMatch): StoredRecent {
  return { relPath: match.relPath, name: match.name, ignored: match.ignored }
}

export function fromStoredRecent(stored: StoredRecent, cwd: string): MentionMatch {
  const root = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  return {
    relPath: stored.relPath,
    absPath: `${root}/${stored.relPath}`,
    name: stored.name,
    ignored: stored.ignored
  }
}

/**
 * Add `match` to the front of the list, dedup by `relPath`, and cap. Pure so
 * it can be unit-tested directly.
 */
export function pushRecent(list: MentionMatch[], match: MentionMatch): MentionMatch[] {
  const deduped = list.filter((m) => m.relPath !== match.relPath)
  return [match, ...deduped].slice(0, MENTION_RECENTS_CAP)
}

type RecentsMap = Record<string, StoredRecent[]>

export async function loadMentionRecents(projectId: string, cwd: string): Promise<MentionMatch[]> {
  const res = await persistenceApi.read<RecentsMap>(ACP_MENTION_RECENTS_KEY)
  if (!res.success || !res.data) return []
  const entries = res.data[compositeKey(projectId, cwd)]
  if (!Array.isArray(entries)) return []
  return entries.map((e) => fromStoredRecent(e, cwd))
}

export async function saveMentionRecents(
  projectId: string,
  cwd: string,
  recents: MentionMatch[]
): Promise<void> {
  const res = await persistenceApi.read<RecentsMap>(ACP_MENTION_RECENTS_KEY)
  const map: RecentsMap = res.success && res.data ? res.data : {}
  map[compositeKey(projectId, cwd)] = recents.map(toStoredRecent)
  const write = await persistenceApi.write(ACP_MENTION_RECENTS_KEY, map)
  if (!write.success) {
    throw new Error(write.error ?? 'Failed to persist mention recents')
  }
}
