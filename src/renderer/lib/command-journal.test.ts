import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCommandJournalForTesting,
  COMMAND_JOURNAL_MAX_AGE_MS,
  COMMAND_JOURNAL_MAX_ENTRIES,
  COMMAND_JOURNAL_STORAGE_KEY,
  findUnresolvedCommand,
  listUnresolvedCommands,
  openCommand,
  resolveCommand
} from './command-journal'
import { logFrontendError } from './log-api'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

describe('command-journal', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    __resetCommandJournalForTesting()
    vi.mocked(logFrontendError).mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('persists the id before returning it, so a reload still finds it (reuse across reload)', () => {
    const entry = openCommand('create_session', 'agent-1|/w|')
    // Stored the moment openCommand returned — before any send could happen.
    expect(window.sessionStorage.getItem(COMMAND_JOURNAL_STORAGE_KEY)).toContain(entry.commandId)

    // A reload loses module memory; storage is the only survivor.
    __resetCommandJournalForTesting()
    const found = findUnresolvedCommand('create_session', 'agent-1|/w|')
    expect(found?.commandId).toBe(entry.commandId)
  })

  it('stores identifiers only: no payload, credential or body field ever lands in storage', () => {
    openCommand('spawn_agent', 'cfg|name|cmd|SECRET-ENV-VALUE')
    const raw = window.sessionStorage.getItem(COMMAND_JOURNAL_STORAGE_KEY) ?? '[]'
    const stored = JSON.parse(raw)
    expect(Object.keys(stored[0]).sort()).toEqual(['commandId', 'createdAt', 'entityKey', 'kind'])
    // The key is digested: nothing content-derived is readable from storage.
    expect(raw).not.toContain('SECRET-ENV-VALUE')
  })

  it('long keys that share a prefix never alias', () => {
    const prefix = 'x'.repeat(600)
    const a = openCommand('create_session', `${prefix}|a`)
    const b = openCommand('create_session', `${prefix}|b`)
    expect(findUnresolvedCommand('create_session', `${prefix}|a`)?.commandId).toBe(a.commandId)
    expect(findUnresolvedCommand('create_session', `${prefix}|b`)?.commandId).toBe(b.commandId)
  })

  it('keeps the in-memory id authoritative after a failed write (storage would show stale state)', () => {
    const entry = openCommand('close_session', 'a|s1')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const second = openCommand('close_session', 'a|s2')
    vi.restoreAllMocks()
    // Storage still holds only the first entry, but the second must be found.
    expect(findUnresolvedCommand('close_session', 'a|s2')?.commandId).toBe(second.commandId)
    expect(findUnresolvedCommand('close_session', 'a|s1')?.commandId).toBe(entry.commandId)
  })

  it('a retry of the same intent finds its id; another kind or entity does not', () => {
    const entry = openCommand('close_session', 'a|s1')
    expect(findUnresolvedCommand('close_session', 'a|s1')?.commandId).toBe(entry.commandId)
    expect(findUnresolvedCommand('close_session', 'a|s2')).toBeNull()
    expect(findUnresolvedCommand('dispose_ephemeral_session', 'a|s1')).toBeNull()
  })

  it('skips ids that a live send is using (a concurrent try is a different command)', () => {
    const first = openCommand('create_session', 'k')
    const second = openCommand('create_session', 'k')
    expect(findUnresolvedCommand('create_session', 'k')?.commandId).toBe(second.commandId)
    expect(
      findUnresolvedCommand('create_session', 'k', Date.now(), new Set([second.commandId]))
        ?.commandId
    ).toBe(first.commandId)
  })

  it('is cleared on resolution: the next try mints a new id', () => {
    const entry = openCommand('promote_session', 'a|s1')
    resolveCommand(entry.commandId)
    expect(findUnresolvedCommand('promote_session', 'a|s1')).toBeNull()
    expect(window.sessionStorage.getItem(COMMAND_JOURNAL_STORAGE_KEY)).toBeNull()
    expect(openCommand('promote_session', 'a|s1').commandId).not.toBe(entry.commandId)
  })

  it('garbage-collects entries past the max age', () => {
    const start = 1_000_000
    const old = openCommand('close_session', 'a|old', start)
    const fresh = openCommand('close_session', 'a|fresh', start + COMMAND_JOURNAL_MAX_AGE_MS - 1)
    const now = start + COMMAND_JOURNAL_MAX_AGE_MS
    expect(findUnresolvedCommand('close_session', 'a|old', now)).toBeNull()
    expect(listUnresolvedCommands(now).map((e) => e.commandId)).toEqual([fresh.commandId])
    expect(old.commandId).not.toBe(fresh.commandId)
  })

  it('is bounded: the oldest entries drop past the cap', () => {
    const first = openCommand('close_session', 'k0')
    for (let i = 1; i <= COMMAND_JOURNAL_MAX_ENTRIES; i++) openCommand('close_session', `k${i}`)
    const kept = listUnresolvedCommands()
    expect(kept).toHaveLength(COMMAND_JOURNAL_MAX_ENTRIES)
    expect(kept.some((e) => e.commandId === first.commandId)).toBe(false)
  })

  it('falls back to memory with ONE warning when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const entry = openCommand('close_session', 'a|s1')
    openCommand('close_session', 'a|s2')
    expect(findUnresolvedCommand('close_session', 'a|s1')?.commandId).toBe(entry.commandId)
    expect(logFrontendError).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(vi.mocked(logFrontendError).mock.calls)).not.toContain(entry.commandId)
  })

  it('ignores a corrupt stored journal instead of throwing', () => {
    window.sessionStorage.setItem(COMMAND_JOURNAL_STORAGE_KEY, '{not json')
    expect(findUnresolvedCommand('close_session', 'a|s1')).toBeNull()
    expect(() => openCommand('close_session', 'a|s1')).not.toThrow()
  })
})
