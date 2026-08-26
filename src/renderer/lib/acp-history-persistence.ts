/** Desktop ACP history persistence boundary. */

import type { PersistedSessionSummary } from '@shared/types/web-protocol.types'
import type { ToolCall } from '@/lib/acp-api'
import { acpHistoryApi } from '@/lib/acp-history-api'
import { getAcpTransport } from '@/lib/acp-transport'
import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import type { ChatMessage, SessionStatus } from '@/stores/acp-store'

export const SESSION_INDEX_KEY = 'acp/sessions/index'
export const WIPE_MIGRATION_KEY = 'acp/sessions/migrated-v2'
export const INACTIVE_PAYLOAD_CACHE_BUDGET = 3

/** Default tail message count for lazy-load chat history open. Smaller than
 * `MAX_LIVE_WINDOW_MESSAGES` (300) — only the recent transcript is needed
 * for the user to read + chat; the full payload loads on scroll-up. */
export const HISTORY_TAIL_MESSAGE_LIMIT = 50

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
  /** Agent-owned metadata mirror created from ACP `session/list`; no local transcript. */
  discovered?: boolean
  /**
   * Worktree path + branch the agent runs in (CAP-3). Additive: absent on
   * pre-feature sessions. Powers the CAP-6 indicator + the deleted-worktree
   * fallback; state isolation still keys on `cwd`.
   */
  worktreePath?: string
  worktreeBranch?: string
}

export interface SessionPayload {
  metadata: SessionIndexEntry
  messages: ChatMessage[]
  /**
   * Durable tool calls mirrored alongside the transcript so history reopens
   * and post-reload resumes restore the tool cards in the timeline. Written
   * through `sanitizeToolCallsForPersistence` (no `rawOutput`, per-call size
   * bound). Absent on payloads persisted before this field existed.
   */
  toolCalls?: ToolCall[]
}

/**
 * Maximum serialized UTF-8 size of a single durable tool call. Calls exceeding
 * the budget degrade to the structural subset so a giant diff or tool input
 * cannot balloon the on-disk payload.
 */
export const PERSISTED_TOOL_CALL_BYTE_BUDGET = 32 * 1024

/**
 * Maximum number of tool calls persisted per session. Tool calls are never
 * trimmed in the live window (messages have `MAX_LIVE_WINDOW_MESSAGES`), so the
 * durable mirror keeps only the most recent calls — the same recency window a
 * reader browses — bounding payload growth on very long sessions.
 */
export const PERSISTED_TOOL_CALLS_LIMIT = 500

/** Agent-controlled titles are bounded so the degraded subset stays bounded. */
const PERSISTED_TOOL_CALL_TITLE_LIMIT = 200

const persistedTextEncoder = new TextEncoder()

function boundedTitle(title: unknown): string | undefined {
  if (typeof title !== 'string' || title.length === 0) return undefined
  return title.length > PERSISTED_TOOL_CALL_TITLE_LIMIT
    ? `${title.slice(0, PERSISTED_TOOL_CALL_TITLE_LIMIT)}…`
    : title
}

/**
 * Structural subset of a durable tool call: routing/status fields + timeline
 * stamps only. Mid-flight statuses are persisted as `failed` — the turn that
 * owned them has ended, and restoring `pending`/`in_progress` would reopen the
 * card spinning forever.
 */
function structuralToolCall(toolCall: ToolCall): ToolCall {
  const reduced: ToolCall = { toolCallId: toolCall.toolCallId }
  const title = boundedTitle(toolCall.title)
  if (title !== undefined) reduced.title = title
  if (toolCall.kind !== undefined) reduced.kind = toolCall.kind
  const status =
    toolCall.status === 'pending' || toolCall.status === 'in_progress' ? 'failed' : toolCall.status
  if (status !== undefined) reduced.status = status
  if (typeof toolCall.timestamp === 'number') reduced.timestamp = toolCall.timestamp
  if (typeof toolCall.seq === 'number') reduced.seq = toolCall.seq
  return reduced
}

/**
 * Mirror-ready tool calls for durable history. `rawOutput` (unbounded tool
 * results) is never persisted, and only the known summary/render fields
 * (`rawInput`, structured `content`) ride along — unknown agent fields are
 * dropped at the boundary. Over-budget calls degrade to the structural subset
 * instead of ballooning the payload; non-serializable calls degrade the same
 * way (and the degradation is logged, never silent).
 */
export function sanitizeToolCallsForPersistence(
  toolCalls: ToolCall[] | undefined
): ToolCall[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined
  const degraded: string[] = []
  const dropped: string[] = []
  const sanitized: ToolCall[] = []
  for (const toolCall of toolCalls.slice(-PERSISTED_TOOL_CALLS_LIMIT)) {
    const candidate = structuralToolCall(toolCall)
    if (toolCall.rawInput !== undefined) candidate.rawInput = toolCall.rawInput
    if (toolCall.content !== undefined) candidate.content = toolCall.content
    let persisted: ToolCall | undefined
    try {
      const bytes = persistedTextEncoder.encode(JSON.stringify(candidate)).byteLength
      if (bytes <= PERSISTED_TOOL_CALL_BYTE_BUDGET) persisted = candidate
    } catch {
      // Non-serializable fields: fall through to the structural subset.
    }
    if (!persisted) {
      // Over budget or non-serializable: degrade to the structural subset, then
      // re-measure it. `toolCallId` is agent-sourced and unbounded, so even the
      // subset can exceed the cap — omit the call entirely in that case so the
      // per-call budget actually holds.
      const structural = structuralToolCall(toolCall)
      const structuralBytes = persistedTextEncoder.encode(JSON.stringify(structural)).byteLength
      if (structuralBytes <= PERSISTED_TOOL_CALL_BYTE_BUDGET) {
        degraded.push(toolCall.toolCallId)
        persisted = structural
      } else {
        dropped.push(toolCall.toolCallId)
      }
    }
    if (persisted) sanitized.push(persisted)
  }
  if (degraded.length > 0 || dropped.length > 0) {
    const parts: string[] = []
    if (degraded.length > 0) {
      parts.push(`degraded ${degraded.length}: ${degraded.slice(0, 3).join(', ')}`)
    }
    if (dropped.length > 0) {
      parts.push(`dropped ${dropped.length} over-size: ${dropped.slice(0, 3).join(', ')}`)
    }
    void logFrontendError({
      level: 'warn',
      source: 'acp.historyPersistence',
      message: `Tool-call persistence budget enforced — ${parts.join('; ')}`
    })
  }
  return sanitized.length > 0 ? sanitized : undefined
}

/** True for a restorable tool-call record: a non-null object with a string id. */
function isRestorableToolCall(value: unknown): value is ToolCall {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as ToolCall
  return typeof candidate.toolCallId === 'string' && candidate.toolCallId.length > 0
}

/** Filter a raw payload array down to restorable tool-call records. */
function normalizedToolCalls(toolCalls: unknown): ToolCall[] {
  if (!Array.isArray(toolCalls)) return []
  return toolCalls.filter(isRestorableToolCall)
}

/**
 * Highest `seq` across a payload's messages and tool calls (they share one
 * timeline counter). Corrupt/partial payloads degrade to the fields present —
 * a non-array `toolCalls`, or one containing non-record entries (`null`,
 * scalar, missing id), never throws on the reopen hot path.
 */
export function maxPayloadSeq(payload: Pick<SessionPayload, 'messages' | 'toolCalls'>): number {
  let maxSeq = 0
  for (const message of payload.messages) {
    if (typeof message.seq === 'number' && Number.isFinite(message.seq) && message.seq > maxSeq) {
      maxSeq = message.seq
    }
  }
  for (const toolCall of normalizedToolCalls(payload.toolCalls)) {
    if (
      typeof toolCall.seq === 'number' &&
      Number.isFinite(toolCall.seq) &&
      toolCall.seq > maxSeq
    ) {
      maxSeq = toolCall.seq
    }
  }
  return maxSeq
}

/** Restored tool calls for a payload, tolerant of legacy/corrupt shapes. */
export function restoredToolCalls(payload: Pick<SessionPayload, 'toolCalls'>): ToolCall[] {
  return normalizedToolCalls(payload.toolCalls)
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
    discovered: entry.discovered,
    toolCount: 0,
    lastSeq: entry.lastSeq ?? 0,
    resumeEligible: Boolean(entry.agentConfigId || entry.agentId),
    worktreePath: entry.worktreePath,
    worktreeBranch: entry.worktreeBranch
  }))
}

export function deriveTitle(messages: ChatMessage[], fallbackTitle: string): string {
  const firstUser = messages.find((message) => message.role === 'user')
  if (firstUser) {
    const text = firstUser.blocks
      .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
      .join(' ')
      .trim()
    const firstLine = text.split(/\r?\n/, 1)[0].trim()
    if (firstLine.length > 0) {
      const characters = Array.from(firstLine)
      return characters.length > 48 ? `${characters.slice(0, 48).join('')}…` : firstLine
    }
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
  cwd: string,
  worktreePaths: string[] = []
): SessionIndexEntry[] {
  if (!projectId || !cwd) return []
  // ADR 0002 scoping with worktree-inclusive reachability: in addition to an
  // exact-cwd match, a session whose cwd is one of the active project's
  // registered worktree paths stays listed. This keeps a worktree chat
  // reachable from the project root view and across restarts where
  // `activeWorktreeId` is null (the sidebar would otherwise hide it because
  // its cwd differs from the root). Falls back to projectId-only matching when
  // the scoped set is empty, preserving the prior drift-tolerant behavior.
  //
  // `normalizeCwdForScope` is required: the host persists session cwds via Rust
  // `Path::canonicalize`, which on Windows yields the verbatim `\\?\` prefix
  // with backslash separators (`\\?\E:\…\wt`), while the project store's
  // worktree paths come from `worktreeApi.list` in forward-slash form
  // (`E:/…/wt`). A raw `===`/`Set.has` never equates the two and would
  // silently hide worktree chats from the root view.
  const normalizedCwd = normalizeCwdForScope(cwd)
  const worktreePathSet =
    worktreePaths.length > 0 ? new Set(worktreePaths.map(normalizeCwdForScope)) : null
  const scoped = entries.filter((entry) => {
    if (entry.projectId !== projectId) return false
    const entryCwd = normalizeCwdForScope(entry.cwd)
    if (entryCwd === normalizedCwd) return true
    return worktreePathSet?.has(entryCwd) ?? false
  })
  return scoped.length > 0 ? scoped : entries.filter((entry) => entry.projectId === projectId)
}

// Canonicalize a cwd/path for comparison: strip the Windows verbatim `\\?\`
// prefix, collapse the extended UNC verbatim prefix `\\?\UNC\` to `//` so it
// matches standard UNC `\\server\share`, unify separators to `/`, and trim
// trailing slashes. Shared between `scopeSessionIndex` (session cwd vs project
// worktree paths) and the launcher's worktree-registration dedup (new worktree
// path vs already-stored paths), so a trailing-slash or verbatim-prefix form
// mismatch can't defeat either check. No lowercasing — preserves case-sensitive
// matching on POSIX where the prefix and backslashes never occur (the transform
// is a no-op there).
export function normalizeCwdForScope(p: string): string {
  if (!p) return p
  return (
    p
      // Extended UNC verbatim prefix `\\?\UNC\server\share` → `//server/share`:
      // collapse to `//` BEFORE the generic verbatim-prefix strip so extended and
      // standard UNC (`\\server\share`) normalize identically.
      .replace(/^\\\\\?\\UNC\\/i, '//')
      .replace(/^\\\\\?\\/, '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
  )
}

function historyMode(): 'server' | 'live_only' | 'tauri_store' | undefined {
  return getAcpTransport().historyMode?.()
}

export function fromPersistedSessionSummary(entry: PersistedSessionSummary): SessionIndexEntry {
  return {
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
    status: entry.status,
    discovered:
      entry.discovered ??
      (entry.messageCount === 0 && entry.toolCount === 0 && entry.lastSeq === 0),
    worktreePath: entry.worktreePath,
    worktreeBranch: entry.worktreeBranch
  }
}

export async function loadSessionIndex(): Promise<SessionIndexEntry[]> {
  const transport = getAcpTransport()
  const mode = transport.historyMode?.()
  if (mode === 'server' && transport.listPersistedSessions) {
    return (await transport.listPersistedSessions()).map(fromPersistedSessionSummary)
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
/**
 * Memoized in-flight backend `acp_history_flush` promise. `beforeunload` +
 * `pagehide` + `closeAppWithPersistenceFlush` can all fire on close,
 * previously triggering 3× concurrent backend flush calls (race + the
 * Windows `Access is denied` os-error-5 failure). Concurrent callers await
 * the SAME promise so exactly one `acpHistoryApi.flush()` reaches the
 * backend. Mirrors the `waitForPendingSessionIndexWrite` in-flight-promise
 * pattern already in this file.
 */
let pendingHistoryFlush: Promise<void> | null = null

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
  pendingHistoryFlush = null
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

/**
 * Tail-first variant of {@link loadSessionPayload}: fetches only the last
 * `limit` messages + matching tool calls so the renderer can install the
 * recent transcript immediately and lazy-load the full payload on scroll-up.
 *
 * Cache-first: if the full payload is already cached (instant second open),
 * slices the tail from it — no IPC. Otherwise fetches via the transport/API
 * tail method. NEVER writes to `payloadCache` — the cache is for full
 * payloads only, and `loadOlderMessages` expects to find (or fetch) the full
 * payload on a cache miss.
 */
export async function loadSessionPayloadTail(
  id: string,
  limit: number = HISTORY_TAIL_MESSAGE_LIMIT
): Promise<SessionPayload | null> {
  // Cache-first: slice the tail from a cached full payload (instant re-open).
  const cached = payloadCache.get(id)
  if (cached) {
    touchPayload(id, cached)
    if (cached.messages.length <= limit) return cached
    const tailStart = cached.messages.length - limit
    return {
      ...cached,
      messages: cached.messages.slice(tailStart),
      toolCalls: cached.toolCalls?.filter(
        (tc) =>
          typeof tc.seq !== 'number' ||
          tc.seq >= (cached.messages[tailStart]?.seq ?? 0)
      )
    }
  }
  // Transport tail (web/remote) → API tail (desktop) → null.
  const transport = getAcpTransport()
  const mode = transport.historyMode?.()
  if (mode === 'server' && transport.getSessionPayloadTail) {
    return transport.getSessionPayloadTail(id, limit)
  }
  if (mode === 'live_only') return null
  return acpHistoryApi.getTail(id, limit)
}

export async function saveSessionPayload(id: string, payload: SessionPayload): Promise<void> {
  // CAP-2: the host event/session layer is now the sole author of durable
  // history in every mode (desktop shared-live included). Renderer payload
  // writes are retired; this stays a no-op so any residual queued save never
  // reaches a store. The payload cache still records the projection locally.
  if (deletedSessionIds.has(id)) return
  touchPayload(id, payload)
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
  // Memoize the in-flight flush promise so `beforeunload` + `pagehide` +
  // `closeAppWithPersistenceFlush` (which can all fire on close) await the
  // SAME backend `acp_history_flush` call instead of racing 3× concurrent
  // flushes (the race produced the Windows `Access is denied` os-error-5
  // failure). A later caller attaches to the in-flight promise and resolves
  // with it; the promise is cleared on settle so a fresh flush after close
  // is not deduped against a stale one.
  if (pendingHistoryFlush) return pendingHistoryFlush
  const flushPromise = (async () => {
    await waitForPendingSessionIndexWrite()
    await acpHistoryApi.flush()
  })()
  pendingHistoryFlush = flushPromise
  try {
    await flushPromise
  } finally {
    // Clear so a subsequent close-path flush (e.g. a second window close
    // after the first settled) can invoke the backend again.
    if (pendingHistoryFlush === flushPromise) {
      pendingHistoryFlush = null
    }
  }
}

export function _clearPayloadCacheForTesting(): void {
  payloadCache.clear()
  pinnedPayloads.clear()
}

export async function runHistoryWipeMigration(): Promise<void> {
  const mode = historyMode()
  if (mode === 'server' || mode === 'live_only') return

  // Reads/verification target the LEGACY store (read-your-writes). Host
  // convergence happens inside `save` / `markLegacyImportComplete`.
  const rustState = await acpHistoryApi.listLegacy()
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
    const existing = await acpHistoryApi.getLegacy(entry.id)
    if (!existing || stablePayload(existing) !== stablePayload(legacy)) {
      throw new Error(`Durable history differs from legacy session ${entry.id}; import left intact`)
    }
  }
  for (const payload of payloads) {
    if (!rustState.sessions.some((entry) => entry.id === payload.metadata.id)) {
      await acpHistoryApi.save(payload.metadata.id, payload)
    }
  }

  const verified = await acpHistoryApi.listLegacy()
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
    const durable = await acpHistoryApi.getLegacy(legacy.metadata.id)
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
