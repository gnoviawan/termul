import { describe, expect, it } from 'vitest'
import { isUntitledTitle, type SessionIndexEntry } from '@/lib/acp-history-persistence'
import { mergeSessionIndexEntries } from './helpers'
import { persistSession } from './shared-state'
import type { AcpSession, ChatMessage } from './types'

// Issue #1798: a chat started on device A gets its derived title on device B
// (the watching device) while the first turn runs. When the turn ends, the
// watching device must NOT revert the row to the `Untitled Chat` placeholder.
// The live `session.title` on a watching device is the placeholder captured at
// payload install (before the host derived the first-message title); the
// `chat_history` delta only titled the INDEX row, never the live session.

const T0 = 1_700_000_000_000

function session(overrides: Partial<AcpSession> = {}): AcpSession {
  return {
    id: 's1',
    agentId: 'a1',
    cwd: '/repo',
    projectId: 'p1',
    status: 'active',
    title: null,
    createdAt: T0,
    ...overrides
  } as unknown as AcpSession
}

function userMessage(text: string): ChatMessage {
  return {
    id: 'turn:1',
    role: 'user',
    blocks: [{ type: 'text', text }],
    streaming: false,
    timestamp: T0,
    seq: 1
  } as unknown as ChatMessage
}

function indexEntry(overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    id: 's1',
    agentId: 'a1',
    title: 'Fix the login bug',
    cwd: '/repo',
    projectId: 'p1',
    createdAt: T0,
    lastActivityAt: T0,
    messageCount: 0,
    status: 'active',
    ...overrides
  } as SessionIndexEntry
}

function persist(sess: AcpSession, messages: ChatMessage[], index: SessionIndexEntry[]) {
  let written: SessionIndexEntry[] = []
  persistSession(
    {
      sessions: { s1: sess },
      messages: { s1: messages },
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

describe('isUntitledTitle', () => {
  it('matches the bare host placeholder and numbered renderer placeholders', () => {
    expect(isUntitledTitle('Untitled Chat')).toBe(true)
    expect(isUntitledTitle('Untitled Chat 1')).toBe(true)
    expect(isUntitledTitle('Untitled Chat 42')).toBe(true)
  })

  it('does not match a real title or nullish input', () => {
    expect(isUntitledTitle('Fix the login bug')).toBe(false)
    expect(isUntitledTitle('Untitled Chat extra')).toBe(false)
    expect(isUntitledTitle(null)).toBe(false)
    expect(isUntitledTitle(undefined)).toBe(false)
  })
})

describe('persistSession keeps the derived title at turn end (#1798)', () => {
  it('does not re-stamp a stale placeholder session title over the derived index title', () => {
    // Watching device: the live session still holds the placeholder captured at
    // payload install, while a `chat_history` delta already titled the index row.
    const sess = session({ title: 'Untitled Chat' })
    const [entry] = persist(sess, [], [indexEntry({ title: 'Fix the login bug' })])
    expect(entry.title).toBe('Fix the login bug')
  })

  it('derives the title from the first user message when the live title is a placeholder', () => {
    const sess = session({ title: 'Untitled Chat 3' })
    const [entry] = persist(
      sess,
      [userMessage('Fix the login bug please')],
      [indexEntry({ title: 'Untitled Chat 3' })]
    )
    expect(entry.title).toBe('Fix the login bug please')
  })

  it('keeps a real index title (e.g. host-generated) over re-deriving from the first message', () => {
    const sess = session({ title: 'Untitled Chat' })
    const [entry] = persist(
      sess,
      [userMessage('fix login pls')],
      [indexEntry({ title: 'Fix login redirect loop' })]
    )
    expect(entry.title).toBe('Fix login redirect loop')
  })

  it('keeps a real local title (e.g. a rename) over the index title', () => {
    const sess = session({ title: 'My renamed chat' })
    const [entry] = persist(sess, [userMessage('whatever')], [indexEntry({ title: 'Old title' })])
    expect(entry.title).toBe('My renamed chat')
  })

  it('still assigns a placeholder for a brand-new untitled chat with no content', () => {
    const sess = session({ title: null })
    const [entry] = persist(sess, [], [])
    expect(isUntitledTitle(entry.title)).toBe(true)
  })
})

describe('mergeSessionIndexEntries protects the host title from a local placeholder (#1798)', () => {
  it('keeps the host derived title when a newer local row is a placeholder', () => {
    const local = [indexEntry({ title: 'Untitled Chat', lastActivityAt: T0 + 1000 })]
    const host = [indexEntry({ title: 'Fix the login bug', lastActivityAt: T0 })]
    const [merged] = mergeSessionIndexEntries(local, host, new Set(['s1']))
    expect(merged.title).toBe('Fix the login bug')
  })

  it('still lets a newer local real title (rename) win over the host', () => {
    const local = [indexEntry({ title: 'Renamed locally', lastActivityAt: T0 + 1000 })]
    const host = [indexEntry({ title: 'Fix the login bug', lastActivityAt: T0 })]
    const [merged] = mergeSessionIndexEntries(local, host, new Set(['s1']))
    expect(merged.title).toBe('Renamed locally')
  })

  it('keeps a local real title when a newer host row is a numbered placeholder', () => {
    const local = [indexEntry({ title: 'Renamed locally', lastActivityAt: T0 })]
    const host = [indexEntry({ title: 'Untitled Chat 4', lastActivityAt: T0 + 1000 })]
    const [merged] = mergeSessionIndexEntries(local, host, new Set(['s1']))
    expect(merged.title).toBe('Renamed locally')
  })

  it('keeps a newer local placeholder only when the host is also a placeholder', () => {
    const local = [indexEntry({ title: 'Untitled Chat 2', lastActivityAt: T0 + 1000 })]
    const host = [indexEntry({ title: 'Untitled Chat', lastActivityAt: T0 })]
    const [merged] = mergeSessionIndexEntries(local, host, new Set(['s1']))
    expect(merged.title).toBe('Untitled Chat 2')
  })
})
