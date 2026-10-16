/**
 * Persistence for recently-@-mentioned files, partitioned by `(projectId, cwd)`
 * — the same partitioning as Agent Chat history (ADR 0002). See ADR 0003.
 *
 * Recents are stored as `{ relPath, name, ignored }` (not absolute paths) so
 * they survive a worktree path moving within a project; the absolute path is
 * rebuilt on load from the active `cwd`.
 */

import { PersistenceKeys } from '@shared/types/persistence.types'
import type { MentionMatch } from '@/components/chat/mention-menu-model'
import { persistenceApi } from '@/lib/api'
import { trimListToCap } from '@/lib/persistence-trim'

export const MENTION_RECENTS_CAP = 20

export interface StoredRecent {
  relPath: string
  name: string
  ignored: boolean
  /** Absent means `'file'` so records saved before folder mentions still parse. */
  kind?: 'file' | 'dir'
}

/** Composite key isolates a project's main checkout from its worktrees. */
export function compositeKey(projectId: string, cwd: string): string {
  return `${projectId}\u0000${cwd}`
}

/**
 * Per-partition storage key. Each `(projectId, cwd)` partition is persisted
 * under its own key so concurrent saves can no longer race on a shared
 * read-modify-write of the whole recents map (a later write would silently
 * erase another partition's recents). `encodeURIComponent` keeps the null
 * separator and path characters safe as a store key.
 */
export function mentionRecentsKey(projectId: string, cwd: string): string {
  return PersistenceKeys.acpMentionRecents(encodeURIComponent(compositeKey(projectId, cwd)))
}

export function toStoredRecent(match: MentionMatch): StoredRecent {
  const base = { relPath: match.relPath, name: match.name, ignored: match.ignored }
  return match.kind === 'dir' ? { ...base, kind: 'dir' } : base
}

export function fromStoredRecent(stored: StoredRecent, cwd: string): MentionMatch {
  const root = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  if (stored.kind === 'dir') {
    return {
      relPath: stored.relPath,
      absPath: `${root}/${stored.relPath}/`,
      name: stored.name,
      ignored: stored.ignored,
      kind: 'dir'
    }
  }
  return {
    relPath: stored.relPath,
    absPath: `${root}/${stored.relPath}`,
    name: stored.name,
    ignored: stored.ignored
  }
}

/**
 * Add `match` to the front of the list, dedup by `relPath` + kind (a file and a
 * folder may share a path name), and cap. Pure so
 * it can be unit-tested directly.
 */
export function pushRecent(list: MentionMatch[], match: MentionMatch): MentionMatch[] {
  const isDir = match.kind === 'dir'
  const deduped = list.filter((m) => m.relPath !== match.relPath || (m.kind === 'dir') !== isDir)
  return [match, ...deduped].slice(0, MENTION_RECENTS_CAP)
}

/** Legacy single-map layout: `{ [compositeKey]: StoredRecent[] }`. Kept only
 * for one-time back-compat reads in {@link loadMentionRecents}. */
type RecentsMap = Record<string, StoredRecent[]>

export async function loadMentionRecents(projectId: string, cwd: string): Promise<MentionMatch[]> {
  const res = await persistenceApi.read<StoredRecent[]>(mentionRecentsKey(projectId, cwd))
  if (res.success && Array.isArray(res.data)) {
    return res.data.map((e) => fromStoredRecent(e, cwd))
  }
  // Back-compat: the first time the per-partition key is missing, fall back to
  // the legacy single-map layout so recents saved before the per-key migration
  // survive the upgrade. Subsequent saves write the per-partition key, so this
  // legacy read runs at most once per partition.
  if (!res.success && res.code === 'KEY_NOT_FOUND') {
    const legacy = await persistenceApi.read<RecentsMap>(PersistenceKeys.acpMentionRecentsLegacy)
    if (legacy.success && legacy.data) {
      const entries = legacy.data[compositeKey(projectId, cwd)]
      if (Array.isArray(entries)) return entries.map((e) => fromStoredRecent(e, cwd))
    }
  }
  return []
}

export async function saveMentionRecents(
  projectId: string,
  cwd: string,
  recents: MentionMatch[]
): Promise<void> {
  // Per-partition write — no read-modify-write, so concurrent saves for
  // different partitions cannot clobber each other.
  // Newest first: past the host's value cap the oldest recents go.
  const stored = trimListToCap(recents.map(toStoredRecent), (kept) => kept, 'head').items
  const write = await persistenceApi.write(mentionRecentsKey(projectId, cwd), stored)
  if (!write.success) {
    throw new Error(write.error ?? 'Failed to persist mention recents')
  }
}
