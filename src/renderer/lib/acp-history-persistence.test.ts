import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: vi.fn(),
    write: vi.fn(),
    writeDebounced: vi.fn(),
    delete: vi.fn()
  }
}))

import { persistenceApi } from '@/lib/api'
import type { ChatMessage } from '@/stores/acp-store'
import {
  deriveTitle,
  groupSessionsByRecency,
  loadSessionIndex,
  SESSION_INDEX_KEY,
  type SessionIndexEntry,
  saveSessionPayload,
  sessionPayloadKey
} from './acp-history-persistence'

function msg(role: ChatMessage['role'], text: string): ChatMessage {
  return { id: `m-${text}`, role, blocks: [{ type: 'text', text }], streaming: false, timestamp: 0 }
}

describe('deriveTitle', () => {
  it('uses the first user message text', () => {
    expect(deriveTitle([msg('agent', 'hi'), msg('user', 'Refactor the auth module')], 'a1')).toBe(
      'Refactor the auth module'
    )
  })
  it('truncates long titles', () => {
    const long = 'x'.repeat(60)
    expect(deriveTitle([msg('user', long)], 'a1')).toBe(`${'x'.repeat(40)}…`)
  })
  it('falls back to the agent id when no user message', () => {
    expect(deriveTitle([msg('agent', 'hello')], 'agent-12345678')).toBe('Agent agent-12')
  })
})

describe('groupSessionsByRecency', () => {
  const now = new Date('2026-05-30T12:00:00').getTime()
  function entry(id: string, lastActivityAt: number): SessionIndexEntry {
    return {
      id,
      agentId: 'a',
      title: id,
      cwd: '',
      createdAt: 0,
      lastActivityAt,
      messageCount: 0,
      status: 'active'
    }
  }
  it('buckets by today/yesterday/earlier and sorts newest-first', () => {
    const today1 = new Date('2026-05-30T09:00:00').getTime()
    const today2 = new Date('2026-05-30T11:00:00').getTime()
    const yest = new Date('2026-05-29T10:00:00').getTime()
    const old = new Date('2026-05-01T10:00:00').getTime()
    const groups = groupSessionsByRecency(
      [entry('t1', today1), entry('t2', today2), entry('y', yest), entry('o', old)],
      now
    )
    expect(groups.map((g) => g.group)).toEqual(['Today', 'Yesterday', 'Earlier'])
    expect(groups[0].entries.map((e) => e.id)).toEqual(['t2', 't1']) // newest first
  })
  it('omits empty groups', () => {
    const groups = groupSessionsByRecency([entry('o', new Date('2026-05-01').getTime())], now)
    expect(groups.map((g) => g.group)).toEqual(['Earlier'])
  })
})

describe('persistence I/O', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loadSessionIndex returns [] on KEY_NOT_FOUND', async () => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      code: 'KEY_NOT_FOUND'
    })
    expect(await loadSessionIndex()).toEqual([])
  })

  it('loadSessionIndex returns the stored array', async () => {
    const list: SessionIndexEntry[] = [
      {
        id: 's1',
        agentId: 'a',
        title: 'T',
        cwd: '',
        createdAt: 0,
        lastActivityAt: 0,
        messageCount: 1,
        status: 'active'
      }
    ]
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: list
    })
    expect(await loadSessionIndex()).toEqual(list)
    expect(persistenceApi.read).toHaveBeenCalledWith(SESSION_INDEX_KEY)
  })

  it('saveSessionPayload uses the debounced writer under the per-session key', async () => {
    ;(persistenceApi.writeDebounced as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true
    })
    const payload = {
      metadata: {
        id: 's1',
        agentId: 'a',
        title: 'T',
        cwd: '',
        createdAt: 0,
        lastActivityAt: 0,
        messageCount: 0,
        status: 'active' as const
      },
      messages: []
    }
    await saveSessionPayload('s1', payload)
    expect(persistenceApi.writeDebounced).toHaveBeenCalledWith(sessionPayloadKey('s1'), payload)
  })
})
