import { describe, expect, it } from 'vitest'
import type { SessionIndexEntry } from '@/lib/acp-history-persistence'
import { mergeSessionIndexEntries } from './helpers'
import { persistSession } from './shared-state'
import type { AcpSession } from './types'

const CREATED = 1_700_000_000_000
const REOPENED = CREATED + 3 * 24 * 60 * 60 * 1000

function indexEntry(overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    id: 's1',
    agentId: 'a1',
    title: 'Fix the login bug',
    cwd: '/repo',
    projectId: 'p1',
    createdAt: CREATED,
    lastActivityAt: CREATED,
    messageCount: 0,
    status: 'idle',
    ...overrides
  } as SessionIndexEntry
}

function persist(sessionCreatedAt: number, index: SessionIndexEntry[]): SessionIndexEntry[] {
  const session = {
    id: 's1',
    agentId: 'a1',
    title: 'Fix the login bug',
    cwd: '/repo',
    projectId: 'p1',
    createdAt: sessionCreatedAt,
    status: 'idle'
  } as unknown as AcpSession
  let written: SessionIndexEntry[] = []
  persistSession(
    {
      sessions: { s1: session },
      messages: { s1: [] },
      toolCalls: {},
      sessionIndex: index,
      configToLiveAgent: {}
    },
    's1',
    (entries) => {
      written = entries
    }
  )
  return written
}

describe('createdAt is first-write-wins', () => {
  it('keeps the indexed createdAt when a reopened chat persists with a fresh stamp', () => {
    const [entry] = persist(REOPENED, [indexEntry()])
    expect(entry.createdAt).toBe(CREATED)
  })

  it('takes the live session createdAt for a chat that is not indexed yet', () => {
    const [entry] = persist(REOPENED, [])
    expect(entry.createdAt).toBe(REOPENED)
  })

  it('replaces a missing (0) indexed createdAt with the live session one', () => {
    const [entry] = persist(REOPENED, [indexEntry({ createdAt: 0 })])
    expect(entry.createdAt).toBe(REOPENED)
  })

  it('keeps the host createdAt when the newer local projection wins the merge', () => {
    const local = [indexEntry({ createdAt: REOPENED, lastActivityAt: REOPENED, title: 'Local' })]
    const host = [indexEntry({ lastActivityAt: CREATED + 1 })]
    const [merged] = mergeSessionIndexEntries(local, host, new Set())
    expect(merged.title).toBe('Local')
    expect(merged.lastActivityAt).toBe(REOPENED)
    expect(merged.createdAt).toBe(CREATED)
  })

  it('falls back to the local createdAt when the host row has none', () => {
    const local = [indexEntry({ lastActivityAt: REOPENED })]
    const host = [indexEntry({ createdAt: 0 })]
    const [merged] = mergeSessionIndexEntries(local, host, new Set())
    expect(merged.createdAt).toBe(CREATED)
  })

  it('keeps createdAt across a reopen, persist and host merge round trip', () => {
    const host = [indexEntry()]
    const persisted = persist(REOPENED, host)
    const [merged] = mergeSessionIndexEntries(persisted, host, new Set(['s1']))
    expect(merged.createdAt).toBe(CREATED)
  })
})
