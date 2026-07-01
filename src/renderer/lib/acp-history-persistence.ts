/**
 * Persistence for ACP chat history.
 *
 * Layout (versioned JSON via persistenceApi):
 *   acp/sessions/index      → SessionIndexEntry[]
 *   acp/sessions/<id>       → SessionPayload { metadata, messages }
 *
 * The store is the runtime source of truth; this is a mirror. Payload writes are
 * debounced so streaming doesn't thrash the disk.
 */
import { persistenceApi } from '@/lib/api'
import type { ChatMessage, SessionStatus } from '@/stores/acp-store'

export const SESSION_INDEX_KEY = 'acp/sessions/index'
/** One-shot flag set after the v2 wipe (see `runHistoryWipeMigration`). */
export const WIPE_MIGRATION_KEY = 'acp/sessions/migrated-v2'
export function sessionPayloadKey(id: string): string {
  return `acp/sessions/${id}`
}

export interface SessionIndexEntry {
  id: string
  agentId: string
  agentConfigId?: string
  title: string
  cwd: string
  /**
   * Owning `Project.id`. The Chats sidebar scopes the index per project +
   * worktree (`(projectId, cwd)`) and falls back to projectId-only matching
   * when the exact cwd yields nothing, so a chat whose cwd drifted since it
   * was created is still shown (see `scopeSessionIndex`). See ADR 0002.
   */
  projectId: string
  createdAt: number
  lastActivityAt: number
  messageCount: number
  status: SessionStatus
}

export interface SessionPayload {
  metadata: SessionIndexEntry
  messages: ChatMessage[]
}

/** Derive a chat title from the first user message; fallback to the agent id. */
export function deriveTitle(messages: ChatMessage[], agentId: string): string {
  const firstUser = messages.find((m) => m.role === 'user')
  if (firstUser) {
    const text = firstUser.blocks
      .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
      .join(' ')
      .trim()
    if (text.length > 0) return text.length > 40 ? `${text.slice(0, 40)}…` : text
  }
  return `Agent ${agentId.slice(0, 8)}`
}

export type RecencyGroup = 'Today' | 'Yesterday' | 'Earlier'

/** Bucket sessions by lastActivityAt relative to `now`. Sorted newest-first within groups. */
export function groupSessionsByRecency(
  entries: SessionIndexEntry[],
  now: number
): { group: RecencyGroup; entries: SessionIndexEntry[] }[] {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()
  const yesterdayMs = todayMs - 24 * 60 * 60 * 1000

  const buckets: Record<RecencyGroup, SessionIndexEntry[]> = {
    Today: [],
    Yesterday: [],
    Earlier: []
  }
  for (const e of entries) {
    if (e.lastActivityAt >= todayMs) buckets.Today.push(e)
    else if (e.lastActivityAt >= yesterdayMs) buckets.Yesterday.push(e)
    else buckets.Earlier.push(e)
  }
  const order: RecencyGroup[] = ['Today', 'Yesterday', 'Earlier']
  return order
    .map((group) => ({
      group,
      entries: buckets[group].slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    }))
    .filter((g) => g.entries.length > 0)
}

/**
 * Scope the session index for the Chats sidebar (ADR 0002). Returns entries
 * whose `(projectId, cwd)` match the active project + worktree/root. When the
 * exact cwd filter yields nothing, falls back to projectId-only matching so a
 * chat whose worktree/cwd drifted since it was created (e.g. after restart or
 * worktree pruning) is still reachable instead of silently hidden. Returns `[]`
 * when `projectId` or `cwd` is empty.
 */
export function scopeSessionIndex(
  entries: SessionIndexEntry[],
  projectId: string,
  cwd: string
): SessionIndexEntry[] {
  if (!projectId || !cwd) return []
  const exact = entries.filter((e) => e.projectId === projectId && e.cwd === cwd)
  if (exact.length > 0) return exact
  return entries.filter((e) => e.projectId === projectId)
}

export async function loadSessionIndex(): Promise<SessionIndexEntry[]> {
  const res = await persistenceApi.read<SessionIndexEntry[]>(SESSION_INDEX_KEY)
  if (res.success && Array.isArray(res.data)) return res.data
  return []
}

/**
 * Track a session-index write so the close path can await it before
 * `window.destroy()`. Mirrors the `waitForPendingAppSettingsPersistence`
 * count/waiter pattern.
 *
 * Takes a **factory** (not a pre-started promise): the write does not begin
 * until prior tracked writes finish. This serializes concurrent persist/delete
 * writes to the same Tauri Store key, so a stale write (e.g. a persist issued
 * just before a delete) cannot land last and win the race.
 *
 * A write queued while the close path is draining is still awaited:
 * `waitForPendingSessionIndexWrite` first awaits the chain, then — if the
 * in-flight count is non-zero — waits on a waiter that resolves only when the
 * count reaches zero, so the last history update is not lost to
 * `window.destroy()`.
 *
 * Errors are logged and swallowed here so the chain never breaks and callers
 * do not need their own `.catch`.
 */
let pendingIndexWrite: Promise<void> = Promise.resolve()
let pendingIndexWriteCount = 0
let pendingIndexWriteWaiters: Array<() => void> = []

function notifyIndexWriteSettled(): void {
  if (pendingIndexWriteCount === 0 && pendingIndexWriteWaiters.length > 0) {
    const waiters = pendingIndexWriteWaiters
    pendingIndexWriteWaiters = []
    for (const resolve of waiters) resolve()
  }
}

/**
 * Serialize and track a session-index write. Returns a promise that resolves
 * once this write (and all writes tracked before it) settle — callers that
 * need to sequence a follow-up (e.g. deleting the payload after the index
 * write) can `await` it.
 */
export function trackPendingIndexWrite(write: () => Promise<void>): Promise<void> {
  pendingIndexWriteCount += 1
  const chained = pendingIndexWrite.then(async () => {
    try {
      await write()
    } catch (e) {
      console.error('[acp] failed to persist session index', e)
    } finally {
      pendingIndexWriteCount = Math.max(0, pendingIndexWriteCount - 1)
      notifyIndexWriteSettled()
    }
  })
  pendingIndexWrite = chained
  return chained
}

export async function waitForPendingSessionIndexWrite(): Promise<void> {
  await pendingIndexWrite
  if (pendingIndexWriteCount === 0) return
  await new Promise<void>((resolve) => {
    pendingIndexWriteWaiters.push(resolve)
  })
}

/** Test-only: reset the tracker between tests to avoid cross-test leakage. */
export function _resetPendingIndexWriteTrackerForTesting(): void {
  pendingIndexWrite = Promise.resolve()
  pendingIndexWriteCount = 0
  pendingIndexWriteWaiters = []
}

export async function saveSessionIndex(entries: SessionIndexEntry[]): Promise<void> {
  const res = await persistenceApi.write(SESSION_INDEX_KEY, entries)
  if (!res.success) {
    throw new Error(res.error ?? 'Failed to persist session index')
  }
}

export async function loadSessionPayload(id: string): Promise<SessionPayload | null> {
  const res = await persistenceApi.read<SessionPayload>(sessionPayloadKey(id))
  if (res.success && res.data) return res.data
  return null
}

export async function saveSessionPayload(id: string, payload: SessionPayload): Promise<void> {
  // Debounced: coalesces streaming updates so disk isn't thrashed.
  const res = await persistenceApi.writeDebounced(sessionPayloadKey(id), payload)
  if (!res.success) {
    throw new Error(res.error ?? 'Failed to persist session payload')
  }
}

export async function deleteSessionPayload(id: string): Promise<void> {
  const res = await persistenceApi.delete(sessionPayloadKey(id))
  if (!res.success) {
    throw new Error(res.error ?? 'Failed to delete session payload')
  }
}

/**
 * One-shot, idempotent wipe of pre-v2 chat history. Sessions persisted before
 * `projectId` was tracked (ADR 0002) cannot be backfilled reliably; the user
 * opted for a fresh start over noise. Gated by `acp/sessions/migrated-v2` so
 * it runs exactly once. Safe to call on every mount.
 */
export async function runHistoryWipeMigration(): Promise<void> {
  const flagRes = await persistenceApi.read<boolean>(WIPE_MIGRATION_KEY)
  if (flagRes.success && flagRes.data === true) return
  // Fail closed: only proceed when the wipe flag is explicitly missing. A
  // transient storage error must NOT wipe history — combined with
  // loadSessionIndex() returning [] on any read failure, proceeding here could
  // write SESSION_INDEX_KEY = [] and set the flag, permanently hiding existing
  // sessions. Throw so the caller (useAcpHistory) can skip the wipe and still
  // load the index.
  if (!flagRes.success && flagRes.code !== 'KEY_NOT_FOUND') {
    throw new Error(flagRes.error ?? 'Failed to read wipe-migration flag')
  }

  const indexRes = await persistenceApi.read<SessionIndexEntry[]>(SESSION_INDEX_KEY)
  if (!indexRes.success && indexRes.code !== 'KEY_NOT_FOUND') {
    throw new Error(indexRes.error ?? 'Failed to read session index for wipe migration')
  }
  const index: SessionIndexEntry[] =
    indexRes.success && Array.isArray(indexRes.data) ? indexRes.data : []

  for (const entry of index) {
    try {
      await persistenceApi.delete(sessionPayloadKey(entry.id))
    } catch {
      /* best-effort; the index clear below is what actually hides them */
    }
  }
  await saveSessionIndex([])
  const setFlag = await persistenceApi.write(WIPE_MIGRATION_KEY, true)
  if (!setFlag.success) {
    throw new Error(setFlag.error ?? 'Failed to set wipe-migration flag')
  }
}
