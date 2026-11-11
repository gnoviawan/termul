import { describe, expect, it } from 'vitest'
import type { SessionIndexEntry } from '@/lib/acp-history-persistence'
import { mergeSessionIndexEntries, stampSwitchContinuation } from './helpers'
import { persistSession } from './shared-state'
import type { AcpSession } from './types'

const NOW = 1_700_000_000_000

function indexEntry(overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    id: 's1',
    agentId: 'a1',
    title: 'Fix the login bug',
    cwd: '/repo',
    projectId: 'p1',
    createdAt: NOW,
    lastActivityAt: NOW,
    messageCount: 0,
    status: 'idle',
    ...overrides
  } as SessionIndexEntry
}

describe('mergeSessionIndexEntries continuedFrom carry', () => {
  it('keeps a locally-stamped edge when the newer host row lacks it', () => {
    const local = [indexEntry({ continuedFrom: 'src', lastActivityAt: NOW + 10 })]
    const host = [indexEntry({ lastActivityAt: NOW + 20 })]
    const [merged] = mergeSessionIndexEntries(local, host, new Set())
    expect(merged.continuedFrom).toBe('src')
    expect(merged.lastActivityAt).toBe(NOW + 20)
  })

  it('takes the host edge when the local row has none', () => {
    const local = [indexEntry({ lastActivityAt: NOW + 20 })]
    const host = [indexEntry({ continuedFrom: 'src', lastActivityAt: NOW + 10 })]
    const [merged] = mergeSessionIndexEntries(local, host, new Set())
    expect(merged.continuedFrom).toBe('src')
  })

  it('lets the host edge win when both sides carry one', () => {
    const local = [indexEntry({ continuedFrom: 'stale', lastActivityAt: NOW + 10 })]
    const host = [indexEntry({ continuedFrom: 'src', lastActivityAt: NOW + 20 })]
    const [merged] = mergeSessionIndexEntries(local, host, new Set())
    expect(merged.continuedFrom).toBe('src')
  })

  it('lets the host edge win over a newer local row', () => {
    const local = [indexEntry({ continuedFrom: 'stale', lastActivityAt: NOW + 20 })]
    const host = [indexEntry({ continuedFrom: 'src', lastActivityAt: NOW + 10 })]
    const [merged] = mergeSessionIndexEntries(local, host, new Set())
    expect(merged.continuedFrom).toBe('src')
    expect(merged.lastActivityAt).toBe(NOW + 20)
  })
})

describe('persistSession continuedFrom carry', () => {
  it('carries the stamped edge through an ordinary persist', () => {
    const session = {
      id: 's1',
      agentId: 'a1',
      title: 'Fix the login bug',
      cwd: '/repo',
      projectId: 'p1',
      createdAt: NOW,
      status: 'idle'
    } as unknown as AcpSession
    let written: SessionIndexEntry[] = []
    persistSession(
      {
        sessions: { s1: session },
        messages: { s1: [] },
        toolCalls: {},
        sessionIndex: [indexEntry({ continuedFrom: 'src' })],
        configToLiveAgent: {}
      },
      's1',
      (entries) => {
        written = entries
      }
    )
    expect(written[0].continuedFrom).toBe('src')
  })
})

describe('stampSwitchContinuation', () => {
  it('stamps the target entry with its source', () => {
    const index = stampSwitchContinuation(
      { sessionIndex: [indexEntry({ id: 'dst' }), indexEntry({ id: 'src' })] },
      'dst' as never,
      'src' as never
    )
    expect(index.find((e) => e.id === 'dst')?.continuedFrom).toBe('src')
    expect(index.find((e) => e.id === 'src')?.continuedFrom).toBeUndefined()
  })

  it('is idempotent: the first durable edge wins', () => {
    const index = stampSwitchContinuation(
      { sessionIndex: [indexEntry({ id: 'dst', continuedFrom: 'first' })] },
      'dst' as never,
      'second' as never
    )
    expect(index.find((e) => e.id === 'dst')?.continuedFrom).toBe('first')
  })

  it('refuses a source in another project', () => {
    const index = [indexEntry({ id: 'dst' }), indexEntry({ id: 'src', projectId: 'p2' })]
    expect(stampSwitchContinuation({ sessionIndex: index }, 'dst' as never, 'src' as never)).toBe(
      index
    )
  })

  it('is a no-op for a missing target or a self-edge', () => {
    const index = [indexEntry({ id: 'dst' })]
    expect(stampSwitchContinuation({ sessionIndex: index }, 'ghost' as never, 'src' as never)).toBe(
      index
    )
    expect(stampSwitchContinuation({ sessionIndex: index }, 'dst' as never, 'dst' as never)).toBe(
      index
    )
  })
})
