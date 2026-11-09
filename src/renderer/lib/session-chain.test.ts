import { describe, expect, it } from 'vitest'
import type { SessionIndexEntry } from './acp-history-persistence'
import { chainIds, foldSessionChains, liveSessionIdOf } from './session-chain'

function entry(id: string, over: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    id,
    agentId: `agent-${id}`,
    agentConfigId: `config-${id}`,
    title: `Chat ${id}`,
    cwd: '/repo',
    projectId: 'p1',
    createdAt: 1000,
    lastActivityAt: 1000,
    messageCount: 2,
    status: 'closed',
    ...over
  }
}

describe('foldSessionChains', () => {
  it('passes standalone entries through untouched', () => {
    const entries = [entry('a'), entry('b', { createdAt: 900 })]
    const folded = foldSessionChains(entries)
    expect(folded.map((e) => e.id).sort()).toEqual(['a', 'b'])
    expect(folded.find((e) => e.id === 'a')).toEqual(entries[0])
  })

  it('folds a two-session chain to its terminal member', () => {
    const folded = foldSessionChains([
      entry('src', { title: 'Where was I?', createdAt: 1000, lastActivityAt: 1100 }),
      entry('dst', {
        continuedFrom: 'src',
        title: 'Untitled Chat 2',
        createdAt: 1200,
        lastActivityAt: 1300
      })
    ])
    expect(folded).toHaveLength(1)
    const row = folded[0]
    expect(row.id).toBe('dst')
    expect(row.title).toBe('Where was I?')
    expect(row.messageCount).toBe(4)
    expect(row.createdAt).toBe(1000)
    expect(row.lastActivityAt).toBe(1300)
  })

  it('folds a multi-hop chain A→B→C to C with the ordered agent sequence', () => {
    const folded = foldSessionChains([
      entry('a', { agentConfigId: 'cfg-1', createdAt: 100 }),
      entry('b', { continuedFrom: 'a', agentConfigId: 'cfg-2', createdAt: 200 }),
      entry('c', { continuedFrom: 'b', agentConfigId: 'cfg-3', createdAt: 300 })
    ])
    expect(folded.map((e) => e.id)).toEqual(['c'])
    expect(folded[0].agents).toEqual(['cfg-1', 'cfg-2', 'cfg-3'])
  })

  it('prefers the newest real title when the terminal is still untitled', () => {
    const folded = foldSessionChains([
      entry('src', { title: 'Debugging the deploy' }),
      entry('dst', { continuedFrom: 'src', title: 'Untitled Chat 3' })
    ])
    expect(folded[0].title).toBe('Debugging the deploy')
  })

  it('keeps the terminal title when no member has a real title', () => {
    const folded = foldSessionChains([
      entry('src', { title: 'Untitled Chat' }),
      entry('dst', { continuedFrom: 'src', title: 'Untitled Chat 2' })
    ])
    expect(folded[0].title).toBe('Untitled Chat 2')
  })

  it('dedupes consecutive agent ids across a same-config switch', () => {
    const folded = foldSessionChains([
      entry('src', { agentConfigId: 'cfg-1', agents: ['cfg-1', 'cfg-2'] }),
      entry('dst', { continuedFrom: 'src', agentConfigId: 'cfg-2' })
    ])
    expect(folded[0].agents).toEqual(['cfg-1', 'cfg-2'])
  })

  it('leaves a single-agent chain without an agents list', () => {
    const folded = foldSessionChains([
      entry('src', { agentConfigId: 'cfg-1' }),
      entry('dst', { continuedFrom: 'src', agentConfigId: 'cfg-1' })
    ])
    expect(folded[0].agents).toBeUndefined()
  })

  it('degrades to standalone rows when the source is missing', () => {
    const folded = foldSessionChains([entry('dst', { continuedFrom: 'gone' })])
    expect(folded).toHaveLength(1)
    expect(folded[0].id).toBe('dst')
  })

  it('does not hide entries or loop on a continuedFrom cycle', () => {
    const folded = foldSessionChains([
      entry('a', { continuedFrom: 'b', messageCount: 3 }),
      entry('b', { continuedFrom: 'a', messageCount: 5 })
    ])
    expect(folded.map((e) => e.id).sort()).toEqual(['a', 'b'])
    // A cycle has no terminal: each member keeps its own row AND its own
    // data — merging either into the other would sum their transcripts.
    const a = folded.find((e) => e.id === 'a')
    const b = folded.find((e) => e.id === 'b')
    expect(a?.messageCount).toBe(3)
    expect(b?.messageCount).toBe(5)
    expect(a?.chainIds).toBeUndefined()
    expect(b?.chainIds).toBeUndefined()
  })

  it('keeps a session whose continuer race was lost to a cycle as its own row', () => {
    // 'x' also names 'b' as its source, but 'a' is the newer continuer, so
    // the a↔b loop stays a cycle and 'x' keeps its own standalone row.
    const folded = foldSessionChains([
      entry('x', { continuedFrom: 'b', createdAt: 50, messageCount: 7 }),
      entry('a', { continuedFrom: 'b', createdAt: 200, messageCount: 3 }),
      entry('b', { continuedFrom: 'a', createdAt: 300, messageCount: 5 })
    ])
    expect(folded.map((e) => e.id).sort()).toEqual(['a', 'b', 'x'])
    const x = folded.find((e) => e.id === 'x')
    expect(x?.messageCount).toBe(7)
  })

  it('folds the winning branch of a fork out of a would-be cycle', () => {
    // Same shape but 'x' is the NEWEST continuer of 'b': the a↔b loop breaks
    // into a normal a→b→x chain with 'x' as terminal.
    const folded = foldSessionChains([
      entry('x', { continuedFrom: 'b', createdAt: 400 }),
      entry('a', { continuedFrom: 'b', createdAt: 200 }),
      entry('b', { continuedFrom: 'a', createdAt: 300 })
    ])
    expect(folded.map((e) => e.id)).toEqual(['x'])
    expect(folded[0].chainIds).toEqual(['a', 'b', 'x'])
  })

  it('does not loop on a self-referencing entry', () => {
    const folded = foldSessionChains([entry('a', { continuedFrom: 'a' })])
    expect(folded.map((e) => e.id)).toEqual(['a'])
  })

  it('picks the newest continuer when an index names two for one source', () => {
    const entries = [
      entry('src', { createdAt: 100 }),
      entry('old-fork', { continuedFrom: 'src', createdAt: 200 }),
      entry('new-fork', { continuedFrom: 'src', createdAt: 300 })
    ]
    const folded = foldSessionChains(entries)
    expect(folded.map((e) => e.id).sort()).toEqual(['new-fork', 'old-fork'])
    // The newest continuer wins the chain and absorbs the source's row.
    expect(liveSessionIdOf(entries, 'src')).toBe('new-fork')
    // Membership follows the kept edge only: the winner's chain includes the
    // shared source, while the losing fork keeps just its own branch — deleting
    // it must not remove the source the winner still needs.
    expect(chainIds(entries, 'new-fork')).toEqual(['src', 'new-fork'])
    expect(chainIds(entries, 'old-fork')).toEqual(['old-fork'])
    expect(chainIds(entries, 'src')).toEqual(['src', 'new-fork'])
  })
})

describe('liveSessionIdOf', () => {
  const entries = [
    entry('a', { createdAt: 100 }),
    entry('b', { continuedFrom: 'a', createdAt: 200 }),
    entry('c', { continuedFrom: 'b', createdAt: 300 }),
    entry('solo')
  ]

  it('resolves any chain member to the terminal session', () => {
    expect(liveSessionIdOf(entries, 'a')).toBe('c')
    expect(liveSessionIdOf(entries, 'b')).toBe('c')
    expect(liveSessionIdOf(entries, 'c')).toBe('c')
  })

  it('returns the id for non-chain sessions', () => {
    expect(liveSessionIdOf(entries, 'solo')).toBe('solo')
    expect(liveSessionIdOf(entries, 'absent')).toBe('absent')
  })

  it('stops without looping on a cycle and keeps the queried member', () => {
    const cyc = [entry('x', { continuedFrom: 'y' }), entry('y', { continuedFrom: 'x' })]
    expect(liveSessionIdOf(cyc, 'x')).toBe('x')
    expect(liveSessionIdOf(cyc, 'y')).toBe('y')
  })
})

describe('chainIds', () => {
  it('returns every member oldest→newest for a chain member', () => {
    const entries = [
      entry('a', { createdAt: 100 }),
      entry('b', { continuedFrom: 'a', createdAt: 200 }),
      entry('c', { continuedFrom: 'b', createdAt: 300 })
    ]
    expect(chainIds(entries, 'c')).toEqual(['a', 'b', 'c'])
    expect(chainIds(entries, 'b')).toEqual(['a', 'b', 'c'])
    expect(chainIds(entries, 'a')).toEqual(['a', 'b', 'c'])
  })

  it('returns just the id for standalone and missing sessions', () => {
    expect(chainIds([entry('solo')], 'solo')).toEqual(['solo'])
    expect(chainIds([entry('solo')], 'ghost')).toEqual(['ghost'])
  })

  it('walks partial membership when a link is missing', () => {
    const entries = [entry('b', { continuedFrom: 'gone' }), entry('c', { continuedFrom: 'b' })]
    expect(chainIds(entries, 'c')).toEqual(['b', 'c'])
  })
})
