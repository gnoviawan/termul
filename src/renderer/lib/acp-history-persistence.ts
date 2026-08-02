/** Desktop ACP history persistence boundary. */

import type { PersistedSessionSummary } from '@shared/types/web-protocol.types'
import { acpHistoryApi } from '@/lib/acp-history-api'
import { getAcpTransport } from '@/lib/acp-transport'
import { persistenceApi } from '@/lib/api'
import type { ChatMessage, SessionStatus } from '@/stores/acp-store'

export const SESSION_INDEX_KEY = 'acp/sessions/index'
export const WIPE_MIGRATION_KEY = 'acp/sessions/migrated-v2'
export const INACTIVE_PAYLOAD_CACHE_BUDGET = 3

export function sessionPayloadKey(id: string): string {
  return `acp/sessions/${id}`
}

export interface SessionIndexEntry {
  id: string
  agentId: string
  agentConfigId?: string
  title: string
  cwd: string
  projectId: string
  createdAt: number
  lastActivityAt: number
  messageCount: number
  /**
   * Highest persisted message `seq` for this session (R3 / parent-spec R2
   * index-list completeness). Optional: absent on entries loaded from a Rust
   * index that does not yet surface it (degrades to 0, the pre-R3 value).
   * `get_session_cursor` remains the authoritative functional cursor.
   */
  lastSeq?: number
  status: SessionStatus
}

export interface SessionPayload {
  metadata: SessionIndexEntry
  messages: ChatMessage[]
}

function stablePayload(payload: SessionPayload): string {
  return JSON.stringify(payload)
}

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
    lastSeq: entry.lastSeq ?? 0,
    resumeEligible: Boolean(entry.agentConfigId || entry.agentId)
  }))
}

export function deriveTitle(messages: ChatMessage[], fallbackTitle: string): string {
  const firstUser = messages.find((message) => message.role === 'user')
  if (firstUser) {
    const text = firstUser.blocks
      .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
      .join(' ')
      .trim()
    if (text.length > 0) return text.length > 40 ? `${text.slice(0, 40)}…` : text
  }
  return fallbackTitle
}

export type RecencyGroup = 'Today' | 'Yesterday' | 'Earlier'

export function groupSessionsByRecency<T extends { lastActivityAt: number }>(
  entries: T[],
  now: number
): { group: RecencyGroup; entries: T[] }[] {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const todayMs = startOfToday.getTime()
  const yesterdayMs = todayMs - 24 * 60 * 60 * 1000
  const buckets: Record<RecencyGroup, T[]> = { Today: [], Yesterday: [], Earlier: [] }
  for (const entry of entries) {
    if (entry.lastActivityAt >= todayMs) buckets.Today.push(entry)
    else if (entry.lastActivityAt >= yesterdayMs) buckets.Yesterday.push(entry)
    else buckets.Earlier.push(entry)
  }
  return (['Today', 'Yesterday', 'Earlier'] as const)
    .map((group) => ({
      group,
      entries: buckets[group].slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    }))
    .filter(({ entries: grouped }) => grouped.length > 0)
}

export function scopeSessionIndex(
  entries: SessionIndexEntry[],
  projectId: string,
  cwd: string
): SessionIndexEntry[] {
  if (!projectId || !cwd) return []
  const exact = entries.filter((entry) => entry.projectId === projectId && entry.cwd === cwd)
  return exact.length > 0 ? exact : entries.filter((entry) => entry.projectId === projectId)
}

function historyMode(): 'server' | 'live_only' | 'tauri_store' | undefined {
  return getAcpTransport().historyMode?.()
}

export async function loadSessionIndex(): Promise<SessionIndexEntry[]> {
  const transport = getAcpTransport()
  const mode = transport.historyMode?.()
  if (mode === 'server' && transport.listPersistedSessions) {
    return (await transport.listPersistedSessions()).map((entry) => ({
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
      lastSeq: entry.lastSeq,
      status: entry.status
    }))
  }
  if (mode === 'live_only') return []
  return (await acpHistoryApi.list()).sessions
}

type PendingHistoryWaiter = {
  resolve: () => void
  reject: (error: unknown) => void
}

type PendingHistoryOperation =
  | { kind: 'save'; payload: SessionPayload; waiters: PendingHistoryWaiter[] }
  | { kind: 'delete'; waiters: PendingHistoryWaiter[] }

const pendingHistoryOperations = new Map<string, PendingHistoryOperation>()
const deletedSessionIds = new Set<string>()
let historyDrain: Promise<void> | null = null
let pendingGenericWrite: Promise<void> = Promise.resolve()
let pendingGenericWriteCount = 0

async function drainHistoryOperations(): Promise<void> {
  while (pendingHistoryOperations.size > 0) {
    const next = pendingHistoryOperations.entries().next().value as
      | [string, PendingHistoryOperation]
      | undefined
    if (!next) break
    const [sessionId, operation] = next
    pendingHistoryOperations.delete(sessionId)
    try {
      if (operation.kind === 'save') {
        await saveSessionPayload(sessionId, operation.payload)
      } else {
        await deleteSessionPayload(sessionId)
        deletedSessionIds.delete(sessionId)
      }
      for (const waiter of operation.waiters) waiter.resolve()
    } catch (error) {
      console.error('[acp] failed to persist session history', error)
      if (operation.kind === 'delete') {
        for (const waiter of operation.waiters) waiter.reject(error)
      } else {
        for (const waiter of operation.waiters) waiter.resolve()
      }
    }
  }
}

function ensureHistoryDrain(): void {
  if (historyDrain) return
  historyDrain = drainHistoryOperations().finally(() => {
    historyDrain = null
    if (pendingHistoryOperations.size > 0) ensureHistoryDrain()
  })
}

/** Coalesce streaming writes so only the latest full payload per session is retained. */
export function queueSessionPayloadSave(id: string, payload: SessionPayload): Promise<void> {
  if (deletedSessionIds.has(id)) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const existing = pendingHistoryOperations.get(id)
    const waiter = { resolve, reject }
    const waiters = existing ? [...existing.waiters, waiter] : [waiter]
    pendingHistoryOperations.set(id, { kind: 'save', payload, waiters })
    ensureHistoryDrain()
  })
}

/** Delete is ordered with writes and supersedes every stale pending save for the session. */
export function queueSessionPayloadDelete(id: string): Promise<void> {
  deletedSessionIds.add(id)
  payloadCache.delete(id)
  pinnedPayloads.delete(id)
  return new Promise<void>((resolve, reject) => {
    const existing = pendingHistoryOperations.get(id)
    const waiter = { resolve, reject }
    const waiters = existing ? [...existing.waiters, waiter] : [waiter]
    pendingHistoryOperations.set(id, { kind: 'delete', waiters })
    ensureHistoryDrain()
  })
}

/** Compatibility tracker for non-session test/legacy callers. */
export function trackPendingIndexWrite(write: () => Promise<void>): Promise<void> {
  pendingGenericWriteCount += 1
  const chained = pendingGenericWrite.then(async () => {
    try {
      await write()
    } catch (error) {
      console.error('[acp] failed to persist session history', error)
    } finally {
      pendingGenericWriteCount = Math.max(0, pendingGenericWriteCount - 1)
    }
  })
  pendingGenericWrite = chained
  return chained
}

export async function waitForPendingSessionIndexWrite(): Promise<void> {
  while (historyDrain || pendingHistoryOperations.size > 0 || pendingGenericWriteCount > 0) {
    await Promise.all([historyDrain ?? Promise.resolve(), pendingGenericWrite])
  }
}

export function _resetPendingIndexWriteTrackerForTesting(): void {
  pendingHistoryOperations.clear()
  deletedSessionIds.clear()
  historyDrain = null
  pendingGenericWrite = Promise.resolve()
  pendingGenericWriteCount = 0
}

export async function saveSessionIndex(_entries: SessionIndexEntry[]): Promise<void> {
  // Index ownership moved to Rust; every payload save atomically updates it.
}

const payloadCache = new Map<string, SessionPayload>()
const pinnedPayloads = new Set<string>()

function touchPayload(id: string, payload: SessionPayload): void {
  payloadCache.delete(id)
  payloadCache.set(id, payload)
  evictInactivePayloads()
}

function evictInactivePayloads(): void {
  let inactive = [...payloadCache.keys()].filter((id) => !pinnedPayloads.has(id)).length
  if (inactive <= INACTIVE_PAYLOAD_CACHE_BUDGET) return
  for (const id of payloadCache.keys()) {
    if (pinnedPayloads.has(id)) continue
    payloadCache.delete(id)
    inactive -= 1
    if (inactive <= INACTIVE_PAYLOAD_CACHE_BUDGET) return
  }
}

export function markSessionPayloadPinned(id: string): void {
  pinnedPayloads.add(id)
}

export function unpinSessionPayload(id: string): void {
  pinnedPayloads.delete(id)
  evictInactivePayloads()
}

export function getCachedSessionPayload(id: string): SessionPayload | undefined {
  const payload = payloadCache.get(id)
  if (payload) touchPayload(id, payload)
  return payload
}

export function setCachedSessionPayload(id: string, payload: SessionPayload): void {
  touchPayload(id, payload)
}

export async function loadSessionPayload(id: string): Promise<SessionPayload | null> {
  const transport = getAcpTransport()
  const mode = transport.historyMode?.()
  if (mode === 'server' && transport.getSessionPayload) {
    const payload = await transport.getSessionPayload(id)
    if (payload) touchPayload(id, payload)
    return payload
  }
  const cached = payloadCache.get(id)
  if (cached) {
    touchPayload(id, cached)
    return cached
  }
  if (mode === 'live_only') return null
  const payload = await acpHistoryApi.get(id)
  if (payload) touchPayload(id, payload)
  return payload
}

export async function saveSessionPayload(id: string, payload: SessionPayload): Promise<void> {
  if (deletedSessionIds.has(id)) return
  const mode = historyMode()
  if (mode === 'server' || mode === 'live_only') return

  // If an inactive LRU entry was evicted while its live renderer window stayed
  // trimmed, recover the durable prefix before saving so eviction is lossless.
  let nextPayload = payload
  if (!payloadCache.has(id) && payload.messages.length > 0) {
    const durable = await acpHistoryApi.get(id)
    if (durable) {
      const liveIds = new Set(payload.messages.map((message) => message.id))
      const durablePrefix = durable.messages.filter((message) => !liveIds.has(message.id))
      if (durablePrefix.length > 0) {
        nextPayload = {
          metadata: { ...payload.metadata },
          messages: [...durablePrefix, ...payload.messages]
        }
        nextPayload.metadata.messageCount = nextPayload.messages.length
      }
    }
  }
  touchPayload(id, nextPayload)
  await acpHistoryApi.save(id, nextPayload)
}

export async function deleteSessionPayload(id: string): Promise<void> {
  payloadCache.delete(id)
  pinnedPayloads.delete(id)
  const mode = historyMode()
  if (mode === 'server' || mode === 'live_only') return
  await acpHistoryApi.delete(id)
}

export async function flushSessionHistory(): Promise<void> {
  const mode = historyMode()
  if (mode === 'server' || mode === 'live_only') return
  await waitForPendingSessionIndexWrite()
  await acpHistoryApi.flush()
}

export function _clearPayloadCacheForTesting(): void {
  payloadCache.clear()
  pinnedPayloads.clear()
}

export async function runHistoryWipeMigration(): Promise<void> {
  const mode = historyMode()
  if (mode === 'server' || mode === 'live_only') return

  const rustState = await acpHistoryApi.list()
  if (rustState.legacyImportComplete) return

  const indexResult = await persistenceApi.read<SessionIndexEntry[]>(SESSION_INDEX_KEY)
  if (!indexResult.success && indexResult.code !== 'KEY_NOT_FOUND') {
    throw new Error(indexResult.error)
  }
  if (indexResult.success && !Array.isArray(indexResult.data)) {
    throw new Error('Legacy session index is not an array')
  }
  const legacyIndex = indexResult.success ? indexResult.data : []
  const payloads: SessionPayload[] = []
  for (const entry of legacyIndex) {
    const payloadResult = await persistenceApi.read<SessionPayload>(sessionPayloadKey(entry.id))
    if (!payloadResult.success || !payloadResult.data) {
      throw new Error(payloadResult.success ? 'Legacy payload is empty' : payloadResult.error)
    }
    if (payloadResult.data.metadata.id !== entry.id) {
      throw new Error(`Legacy payload id mismatch for ${entry.id}`)
    }
    if (payloadResult.data.messages.length !== entry.messageCount) {
      throw new Error(`Legacy payload message count mismatch for ${entry.id}`)
    }
    payloads.push(payloadResult.data)
  }

  const legacyById = new Map(payloads.map((payload) => [payload.metadata.id, payload]))
  for (const entry of rustState.sessions) {
    const legacy = legacyById.get(entry.id)
    if (!legacy) continue
    const existing = await acpHistoryApi.get(entry.id)
    if (!existing || stablePayload(existing) !== stablePayload(legacy)) {
      throw new Error(`Durable history differs from legacy session ${entry.id}; import left intact`)
    }
  }
  for (const payload of payloads) {
    if (!rustState.sessions.some((entry) => entry.id === payload.metadata.id)) {
      await acpHistoryApi.save(payload.metadata.id, payload)
    }
  }

  const verified = await acpHistoryApi.list()
  for (const legacy of payloads) {
    const verifiedEntry = verified.sessions.find((entry) => entry.id === legacy.metadata.id)
    if (
      !verifiedEntry ||
      verifiedEntry.messageCount !== legacy.messages.length ||
      verifiedEntry.title !== legacy.metadata.title ||
      verifiedEntry.projectId !== legacy.metadata.projectId ||
      verifiedEntry.cwd !== legacy.metadata.cwd
    ) {
      throw new Error(`Legacy import metadata verification failed for ${legacy.metadata.id}`)
    }
    const durable = await acpHistoryApi.get(legacy.metadata.id)
    if (!durable || stablePayload(durable) !== stablePayload(legacy)) {
      throw new Error(`Legacy payload verification failed for ${legacy.metadata.id}`)
    }
  }

  try {
    for (const entry of legacyIndex) {
      const result = await persistenceApi.delete(sessionPayloadKey(entry.id))
      if (!result.success) throw new Error(result.error)
    }
    if (indexResult.success) {
      const result = await persistenceApi.delete(SESSION_INDEX_KEY)
      if (!result.success) throw new Error(result.error)
    }
    await acpHistoryApi.markLegacyImportComplete()
  } catch (error) {
    // Fail closed even if cleanup fails part-way: restore the complete legacy
    // source so the next launch can retry instead of inheriting a partial set.
    const rollbackFailures: string[] = []
    for (const payload of payloads) {
      const result = await persistenceApi.write(sessionPayloadKey(payload.metadata.id), payload)
      if (!result.success) rollbackFailures.push(result.error)
    }
    if (indexResult.success) {
      const result = await persistenceApi.write(SESSION_INDEX_KEY, legacyIndex)
      if (!result.success) rollbackFailures.push(result.error)
    }
    if (rollbackFailures.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackFailures.join('; ')}`
      )
    }
    throw error
  }
}
