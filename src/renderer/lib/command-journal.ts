/**
 * Command journal (AD-5/AD-6): the client-side record of mutating commands
 * that were SENT but have not resolved yet.
 *
 * A `commandId` is minted here and persisted BEFORE the command is sent, so a
 * reload (or a crash between "send" and "reply") can never lose the id a
 * resend must reuse — the host resolves a same-id resend by entity lookup or
 * its receipt ledger and never runs the command twice. An entry is dropped on
 * resolution (accepted or definitely rejected); a retry of a rejected command
 * therefore mints a NEW id.
 *
 * Entries are `{ commandId, kind, entityKey, createdAt }` only — never a
 * payload, credential, env value or request body. `entityKey` is the digest of
 * a key naming WHAT the command acts on, so a retry of the same intent finds
 * its unresolved id.
 *
 * Storage can throw (disabled storage, opaque origins, quota). The journal
 * then lives in module memory for the page lifetime and logs one warning,
 * mirroring `web-client-identity.ts`. The journal is bounded (entry count) and
 * age-collected: an entry older than {@link COMMAND_JOURNAL_MAX_AGE_MS} is
 * dropped, because a retry that late is a new intent, not a resend.
 */

import { logFrontendError } from './log-api'
import { sha256Hex } from './sha256-hex'
import { randomUUID } from './uuid'

export const COMMAND_JOURNAL_STORAGE_KEY = 'termul.commandJournal'
/** Most unresolved commands kept; the oldest are dropped past this. */
export const COMMAND_JOURNAL_MAX_ENTRIES = 64
/**
 * Age past which an unresolved entry is discarded. Also the window in which a
 * retry of the same intent reuses the id (the host keeps outcomes at least
 * this long, so a same-id resend inside it gets the original outcome).
 */
export const COMMAND_JOURNAL_MAX_AGE_MS = 10 * 60_000
/**
 * `entityKey` is stored as the SHA-256 of the full key, never a prefix: two
 * distinct intents never alias, and nothing content-derived (an agent's args /
 * env contribute to some keys) is readable from storage.
 */
export function keyDigest(entityKey: string): string {
  return sha256Hex(entityKey)
}

export interface CommandJournalEntry {
  commandId: string
  kind: string
  entityKey: string
  /** Epoch ms the id was minted. */
  createdAt: number
  /**
   * The host reported `outcome_unknown` for this id: it no longer knows whether
   * the command ran and will not run it again. A later try of the same intent
   * is the user resolving that — a new intent with a NEW id — also after a
   * reload, so the flag lives with the entry, not in memory.
   */
  outcomeUnknown?: true
}

/** Page-lifetime copy; the source of truth only while storage is unusable. */
let memoryEntries: CommandJournalEntry[] = []
/**
 * The last write to storage failed: `memoryEntries` is then newer than storage
 * and stays authoritative on read (storage would show stale or empty state and
 * a retry would mint a new id for a command that is already unresolved).
 */
let memoryAuthoritative = false
let warnedFallback = false

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.sessionStorage
  } catch {
    // Access can throw (disabled storage / opaque origins) — treat as absent.
    return null
  }
}

function warnFallback(operation: 'read' | 'write'): void {
  if (warnedFallback) return
  warnedFallback = true
  // Operation only — never an id or key.
  void logFrontendError({
    level: 'warn',
    source: 'command-journal',
    message: `sessionStorage ${operation} for the command journal failed; unresolved command ids are kept in memory for this page only`
  })
}

function isEntry(value: unknown): value is CommandJournalEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.commandId === 'string' &&
    entry.commandId.length > 0 &&
    typeof entry.kind === 'string' &&
    typeof entry.entityKey === 'string' &&
    typeof entry.createdAt === 'number' &&
    Number.isFinite(entry.createdAt) &&
    (entry.outcomeUnknown === undefined || entry.outcomeUnknown === true)
  )
}

function load(): CommandJournalEntry[] {
  if (memoryAuthoritative) return memoryEntries
  const storage = safeStorage()
  if (!storage) {
    warnFallback('read')
    return memoryEntries
  }
  try {
    const raw = storage.getItem(COMMAND_JOURNAL_STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isEntry) : []
  } catch {
    // Unreadable or corrupt: fall back to whatever this page remembers.
    warnFallback('read')
    return memoryEntries
  }
}

function save(entries: CommandJournalEntry[]): void {
  memoryEntries = entries
  const storage = safeStorage()
  if (!storage) {
    memoryAuthoritative = true
    warnFallback('write')
    return
  }
  try {
    if (entries.length === 0) storage.removeItem(COMMAND_JOURNAL_STORAGE_KEY)
    else storage.setItem(COMMAND_JOURNAL_STORAGE_KEY, JSON.stringify(entries))
    memoryAuthoritative = false
  } catch {
    memoryAuthoritative = true
    warnFallback('write')
  }
}

function collect(entries: CommandJournalEntry[], now: number): CommandJournalEntry[] {
  const fresh = entries.filter((entry) => now - entry.createdAt < COMMAND_JOURNAL_MAX_AGE_MS)
  return fresh.length > COMMAND_JOURNAL_MAX_ENTRIES
    ? fresh.slice(fresh.length - COMMAND_JOURNAL_MAX_ENTRIES)
    : fresh
}

/**
 * Mint a `commandId` for `kind` acting on `entityKey` and persist it. Returns
 * only after the entry is stored, so the caller sends strictly after.
 */
export function openCommand(
  kind: string,
  entityKey: string,
  now = Date.now()
): CommandJournalEntry {
  const entry: CommandJournalEntry = {
    commandId: randomUUID(),
    kind,
    entityKey: keyDigest(entityKey),
    createdAt: now
  }
  save([...collect(load(), now), entry])
  return entry
}

/**
 * The newest unresolved entry for the same intent, or `null`. A retry of a
 * pending / pending-reconcile command reuses its id; with no entry (resolved,
 * rejected or aged out) the caller mints a new one. `exclude` skips ids that
 * are currently in use by a live send (a concurrent try is a different command).
 */
export function findUnresolvedCommand(
  kind: string,
  entityKey: string,
  now = Date.now(),
  exclude?: ReadonlySet<string>
): CommandJournalEntry | null {
  const key = keyDigest(entityKey)
  const entries = collect(load(), now)
  for (let i = entries.length - 1; i >= 0; i--) {
    if (
      entries[i].kind === kind &&
      entries[i].entityKey === key &&
      !exclude?.has(entries[i].commandId)
    ) {
      return entries[i]
    }
  }
  return null
}

/** Record that the host no longer knows the outcome of `commandId`. */
export function markOutcomeUnknown(commandId: string): void {
  const entries = load()
  let changed = false
  const marked = entries.map((entry) => {
    if (entry.commandId !== commandId || entry.outcomeUnknown) return entry
    changed = true
    return { ...entry, outcomeUnknown: true as const }
  })
  if (changed) save(marked)
}

/** Drop a resolved command (accepted, or definitely rejected). */
export function resolveCommand(commandId: string): void {
  const entries = load()
  const remaining = entries.filter((entry) => entry.commandId !== commandId)
  if (remaining.length !== entries.length) save(remaining)
}

/** Unresolved commands, oldest first (aged-out entries excluded). */
export function listUnresolvedCommands(now = Date.now()): CommandJournalEntry[] {
  return collect(load(), now)
}

/** Test seam: forget everything, storage included (a fresh page with no history). */
export function __clearCommandJournalForTesting(): void {
  __resetCommandJournalForTesting()
  try {
    if (typeof window !== 'undefined') window.sessionStorage.removeItem(COMMAND_JOURNAL_STORAGE_KEY)
  } catch {
    // Storage unavailable: nothing persisted to clear.
  }
}

/** Test seam: drop the in-memory fallback and the warn latch (storage survives, like a reload). */
export function __resetCommandJournalForTesting(): void {
  memoryEntries = []
  memoryAuthoritative = false
  warnedFallback = false
}
