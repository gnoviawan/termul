import { describe, expect, it } from 'vitest'
import type { SessionIndexEntry } from '@/lib/acp-history-persistence'
import { agentReuseKey } from '../acp-reuse-keys'
import { mergeSessionIndexEntries } from './helpers'
import { persistSession } from './shared-state'
import type { AcpSession } from './types'

const T0 = 1_700_000_000_000

function indexEntry(overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    id: 's1',
    agentId: 'a1',
    agentConfigId: 'acp-registry:claude-acp',
    title: 'Fix the login bug',
    cwd: '/repo',
    projectId: 'p1',
    createdAt: T0,
    lastActivityAt: T0,
    messageCount: 0,
    status: 'closed',
    ...overrides
  } as SessionIndexEntry
}

function persist(
  index: SessionIndexEntry[],
  configToLiveAgent: Record<string, string>
): SessionIndexEntry[] {
  const session = {
    id: 's1',
    agentId: 'a1',
    title: 'Fix the login bug',
    cwd: '/repo',
    projectId: 'p1',
    createdAt: T0,
    status: 'closed'
  } as unknown as AcpSession
  let written: SessionIndexEntry[] = []
  persistSession(
    {
      sessions: { s1: session },
      messages: { s1: [] },
      toolCalls: {},
      sessionIndex: index,
      configToLiveAgent
    },
    's1',
    (entries) => {
      written = entries
    }
  )
  return written
}

describe('a chat keeps its agent config after the agent leaves the live map', () => {
  it('keeps the indexed agentConfigId when the agent is no longer live', () => {
    const [entry] = persist([indexEntry()], {})
    expect(entry.agentConfigId).toBe('acp-registry:claude-acp')
  })

  it('takes the live config when the agent is still mapped', () => {
    const [entry] = persist([indexEntry()], { [agentReuseKey('codex', '/repo', 'p1')]: 'a1' })
    expect(entry.agentConfigId).toBe('codex')
  })

  it('keeps the host agentConfigId when a newer local row has none', () => {
    const local = [indexEntry({ agentConfigId: undefined, lastActivityAt: T0 + 1000 })]
    const host = [indexEntry()]
    const [merged] = mergeSessionIndexEntries(local, host, new Set())
    expect(merged.lastActivityAt).toBe(T0 + 1000)
    expect(merged.agentConfigId).toBe('acp-registry:claude-acp')
  })
})
