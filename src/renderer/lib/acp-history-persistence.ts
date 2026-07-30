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

import type { PersistedSessionSummary } from '@shared/types/web-protocol.types'
import { getAcpTransport } from '@/lib/acp-transport'
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

/**
 * Convert the renderer's local `SessionIndexEntry[]` to the wire
 * `PersistedSessionSummary[]` shape for the `syncChatHistory` push (Epic-4
 * bridge). The renderer is the source of truth; this fills the server-side-only
 * fields (`storageKey`, `toolCount`, `lastSeq`) with sensible defaults and
 * derives `resumeEligible` from the presence of a stable agent config id.
 */
export function toPersistedSessionSummaries(
  entries: SessionIndexEntry[]
): PersistedSessionSummary[] {
  return entries.map((entry) => ({
    storageKey: entry.id,
    sessionId: entry.id,
    stableAgentNamespace: entry.agentConfigId ? `config:${entry.agentConfigId}` : null,
    runtimeAgentId: entry.agentId || undefined,
    projectId: entry.projectId || undefined,
    cwd: entry.cwd,
    title: entry.title,
    createdAt: entry.createdAt,
    lastActivityAt: entry.lastActivityAt,
    status: entry.status === 'initializing' ? 'active' : entry.status,
    messageCount: entry.messageCount,
    toolCount: 0,
    lastSeq: 0,
    // A session is a reopen CANDIDATE when it has a stable agent config id OR
    // a runtime agent id (ad-hoc / `agent-safe:*` agents without a config).
    // The actual capability check still gates the reopen in
    // `openHistorySession`/`openDiscoveredSession`, and
    // `try_reopen_session_for_switch` falls back to the unfiltered lookup when
    // the current agent's namespace can't be resolved. `stableAgentNamespace`
    // stays `config:<configId>` or `null` (the backend-computed `agent-safe:*`
    // namespace sync is deferred — noted in the commit message, not here).
    resumeEligible: Boolean(entry.agentConfigId || entry.agentId)
  }))
}

/** Derive a chat title from the first user message; fallback to the provided title. */
export function deriveTitle(messages: ChatMessage[], fallbackTitle: string): string {
  const firstUser = messages.find((m) => m.role === 'user')
  if (firstUser) {
    const text = firstUser.blocks
      .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
      .join(' ')
      .trim()
    if (text.length > 0) return text.length > 40 ? `${text.slice(0, 40)}…` : text
  }
  return fallbackTitle
}

export type RecencyGroup = 'Today' | 'Yesterday' | 'Earlier'

/** Bucket sessions by lastActivityAt relative to `now`. Sorted newest-first within groups. */
export function groupSessionsByRecency<T extends { lastActivityAt: number }>(
  entries: T[],
  now: number
): { group: RecencyGroup; entries: T[] }[] {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()
  const yesterdayMs = todayMs - 24 * 60 * 60 * 1000

  const buckets: Record<RecencyGroup, T[]> = {
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
  const transport = getAcpTransport()
  if (transport.historyMode?.() === 'server' && transport.listPersistedSessions) {
    const summaries = await transport.listPersistedSessions()
    return summaries.map((entry) => ({
      id: entry.sessionId,
      agentId: entry.runtimeAgentId ?? '',
      agentConfigId: entry.stableAgentNamespace?.startsWith('config:')
        ? entry.stableAgentNamespace.slice('config:'.length)
        : undefined,
      title: entry.title ?? 'Untitled Chat',
      cwd: entry.cwd,
      projectId: entry.projectId ?? '',
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastActivityAt,
      messageCount: entry.messageCount,
      status: entry.status
    }))
  }
  if (transport.historyMode?.() === 'live_only') return []
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
  const mode = getAcpTransport().historyMode?.()
  if (mode === 'server' || mode === 'live_only') return
  const res = await persistenceApi.write(SESSION_INDEX_KEY, entries)
  if (!res.success) {
    throw new Error(res.error ?? 'Failed to persist session index')
  }
}

/**
 * Module-level payload cache so scroll-up rehydrations don't re-read disk.
 * Populated by `loadSessionPayload` (read-through) and `saveSessionPayload`
 * (write-through). Holds the **full** transcript — the live React window is
 * a trimmed projection of this. `persistSession` merges the cache with the
 * live window so trimming never prunes the persisted copy.
 */
const payloadCache = new Map<string, SessionPayload>()

/** Read the cached full payload (no disk read). Undefined when not cached. */
export function getCachedSessionPayload(id: string): SessionPayload | undefined {
  return payloadCache.get(id)
}

/** Replace the cached full payload (used by `persistSession` after merge). */
export function setCachedSessionPayload(id: string, payload: SessionPayload): void {
  payloadCache.set(id, payload)
}

export async function loadSessionPayload(id: string): Promise<SessionPayload | null> {
  const transport = getAcpTransport()
  const mode = transport.historyMode?.()
  // Server mode: this process is not the sole writer (other clients/hosts can
  // update the server cache). Always re-fetch so transcripts written elsewhere
  // are visible; refresh the local cache with the latest payload.
  if (mode === 'server' && transport.getSessionPayload) {
    const payload = await transport.getSessionPayload(id)
    if (payload) payloadCache.set(id, payload)
    return payload
  }
  // Desktop/file modes: this process is the sole writer — cache-first avoids
  // re-reading disk on every scroll-up rehydration.
  const cached = payloadCache.get(id)
  if (cached) return cached
  if (mode === 'live_only') return null
  const res = await persistenceApi.read<SessionPayload>(sessionPayloadKey(id))
  if (res.success && res.data) {
    payloadCache.set(id, res.data)
    return res.data
  }
  return null
}

export async function saveSessionPayload(id: string, payload: SessionPayload): Promise<void> {
  // Update the cache immediately so the merge in `persistSession` always sees
  // the latest full payload, even before the debounced disk write settles.
  payloadCache.set(id, payload)
  const mode = getAcpTransport().historyMode?.()
  if (mode === 'server' || mode === 'live_only') return
  // Debounced: coalesces streaming updates so disk isn't thrashed.
  const res = await persistenceApi.writeDebounced(sessionPayloadKey(id), payload)
  if (!res.success) {
    throw new Error(res.error ?? 'Failed to persist session payload')
  }
}

export async function deleteSessionPayload(id: string): Promise<void> {
  payloadCache.delete(id)
  const mode = getAcpTransport().historyMode?.()
  if (mode === 'server' || mode === 'live_only') return
  const res = await persistenceApi.delete(sessionPayloadKey(id))
  if (!res.success) {
    throw new Error(res.error ?? 'Failed to delete session payload')
  }
}

/** Test-only: clear the payload cache between tests to avoid cross-test leakage. */
export function _clearPayloadCacheForTesting(): void {
  payloadCache.clear()
}

/**
 * One-shot, idempotent wipe of pre-v2 chat history. Sessions persisted before
 * `projectId` was tracked (ADR 0002) cannot be backfilled reliably; the user
 * opted for a fresh start over noise. Gated by `acp/sessions/migrated-v2` so
 * it runs exactly once. Safe to call on every mount.
 */
export async function runHistoryWipeMigration(): Promise<void> {
  const mode = getAcpTransport().historyMode?.()
  if (mode === 'server' || mode === 'live_only') return
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
