import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockTransport = {
  historyMode: vi.fn(() => 'tauri_store' as const),
  listPersistedSessions: vi.fn(),
  openPersistedSession: vi.fn(),
  getSessionPayload: vi.fn()
}

vi.mock('@/lib/acp-transport', () => ({ getAcpTransport: () => mockTransport }))

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
  _resetPendingIndexWriteTrackerForTesting,
  deriveTitle,
  groupSessionsByRecency,
  loadSessionIndex,
  loadSessionPayload,
  runHistoryWipeMigration,
  SESSION_INDEX_KEY,
  type SessionIndexEntry,
  saveSessionPayload,
  scopeSessionIndex,
  sessionPayloadKey,
  toPersistedSessionSummaries,
  trackPendingIndexWrite,
  WIPE_MIGRATION_KEY,
  waitForPendingSessionIndexWrite
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
  it('falls back to the provided title when no user message', () => {
    expect(deriveTitle([msg('agent', 'hello')], 'Untitled Chat 1')).toBe('Untitled Chat 1')
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
      projectId: 'p1',
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
  beforeEach(() => {
    vi.clearAllMocks()
    mockTransport.historyMode.mockReturnValue('tauri_store')
  })

  it('loads safe summaries from the standalone server provider', async () => {
    mockTransport.historyMode.mockReturnValue('server')
    mockTransport.listPersistedSessions.mockResolvedValue([
      {
        storageKey: 'opaque',
        sessionId: 's-server',
        stableAgentNamespace: 'config:cfg-1',
        runtimeAgentId: 'runtime-old',
        projectId: 'p1',
        cwd: '/srv/project',
        title: 'Server chat',
        createdAt: 1,
        lastActivityAt: 2,
        status: 'closed',
        messageCount: 3,
        toolCount: 1,
        lastSeq: 7,
        resumeEligible: true
      }
    ])
    await expect(loadSessionIndex()).resolves.toEqual([
      expect.objectContaining({ id: 's-server', agentConfigId: 'cfg-1', title: 'Server chat' })
    ])
    expect(persistenceApi.read).not.toHaveBeenCalled()
  })

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
        projectId: 'p1',
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
        projectId: 'p1',
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

describe('runHistoryWipeMigration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTransport.historyMode.mockReturnValue('tauri_store')
  })

  it('is a no-op when the v2 flag is already true', async () => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: true
    })
    await runHistoryWipeMigration()
    expect(persistenceApi.delete).not.toHaveBeenCalled()
    expect(persistenceApi.write).not.toHaveBeenCalledWith(WIPE_MIGRATION_KEY, true)
  })

  it('deletes every payload, clears the index, and sets the flag on first run', async () => {
    const stale: SessionIndexEntry[] = [
      {
        id: 'old-1',
        agentId: 'a',
        title: 'x',
        cwd: '/p',
        projectId: 'p1',
        createdAt: 0,
        lastActivityAt: 0,
        messageCount: 1,
        status: 'closed'
      },
      {
        id: 'old-2',
        agentId: 'a',
        title: 'y',
        cwd: '/p',
        projectId: 'p1',
        createdAt: 0,
        lastActivityAt: 0,
        messageCount: 2,
        status: 'closed'
      }
    ]
    ;(persistenceApi.read as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: false, code: 'KEY_NOT_FOUND' }) // flag not set
      .mockResolvedValueOnce({ success: true, data: stale }) // index read
    ;(persistenceApi.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })
    ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

    await runHistoryWipeMigration()

    expect(persistenceApi.delete).toHaveBeenCalledWith(sessionPayloadKey('old-1'))
    expect(persistenceApi.delete).toHaveBeenCalledWith(sessionPayloadKey('old-2'))
    expect(persistenceApi.write).toHaveBeenCalledWith(SESSION_INDEX_KEY, [])
    expect(persistenceApi.write).toHaveBeenCalledWith(WIPE_MIGRATION_KEY, true)
  })

  it('does not re-run after the flag is set', async () => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: true
    })
    await runHistoryWipeMigration()
    await runHistoryWipeMigration()
    expect(persistenceApi.delete).not.toHaveBeenCalled()
  })

  it('fails closed (throws) on a transient flag-read error and does not wipe', async () => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      code: 'READ_ERROR',
      error: 'storage unavailable'
    })
    ;(persistenceApi.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })
    ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

    await expect(runHistoryWipeMigration()).rejects.toThrow('storage unavailable')
    expect(persistenceApi.delete).not.toHaveBeenCalled()
    expect(persistenceApi.write).not.toHaveBeenCalledWith(SESSION_INDEX_KEY, [])
    expect(persistenceApi.write).not.toHaveBeenCalledWith(WIPE_MIGRATION_KEY, true)
  })

  it('fails closed (throws) on a transient index-read error and does not wipe', async () => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: false, code: 'KEY_NOT_FOUND' }) // flag not set
      .mockResolvedValueOnce({ success: false, code: 'READ_ERROR', error: 'storage unavailable' }) // index
    ;(persistenceApi.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })
    ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })

    await expect(runHistoryWipeMigration()).rejects.toThrow('storage unavailable')
    expect(persistenceApi.delete).not.toHaveBeenCalled()
    expect(persistenceApi.write).not.toHaveBeenCalledWith(WIPE_MIGRATION_KEY, true)
  })
})

describe('trackPendingIndexWrite / waitForPendingSessionIndexWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTransport.historyMode.mockReturnValue('tauri_store')
    _resetPendingIndexWriteTrackerForTesting()
  })

  // Drain the microtask queue (via one macrotask) so promise chains settle
  // without relying on a fixed number of `await Promise.resolve()` ticks.
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('resolves immediately when no pending write has been tracked', async () => {
    await expect(waitForPendingSessionIndexWrite()).resolves.toBeUndefined()
  })

  it('waits for an in-flight write to complete', async () => {
    let resolveWrite: () => void
    const pending = new Promise<void>((resolve) => {
      resolveWrite = resolve
    })
    void trackPendingIndexWrite(() => pending)

    let waitDone = false
    void waitForPendingSessionIndexWrite().then(() => {
      waitDone = true
    })

    await flush()
    expect(waitDone).toBe(false)

    resolveWrite!()
    await waitForPendingSessionIndexWrite()
    expect(waitDone).toBe(true)
  })

  it('handles write rejection without throwing and logs the error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    void trackPendingIndexWrite(() => Promise.reject(new Error('write failed')))

    // The wait function should not throw — errors are logged and swallowed by
    // trackPendingIndexWrite so the chain never breaks.
    await expect(waitForPendingSessionIndexWrite()).resolves.toBeUndefined()
    expect(consoleError).toHaveBeenCalledWith(
      '[acp] failed to persist session index',
      expect.any(Error)
    )
    consoleError.mockRestore()
  })

  it('serializes concurrent writes so a stale write cannot land last', async () => {
    // Regression for the persist/delete race: the second factory must not be
    // called until the first write finishes, so writes never overlap on the
    // same Tauri Store key.
    const order: string[] = []
    let resolveFirst: () => void
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const firstWrite = vi.fn(() => {
      order.push('first-start')
      return first.then(() => {
        order.push('first-end')
      })
    })
    const secondWrite = vi.fn(() => {
      order.push('second-start')
      return Promise.resolve().then(() => {
        order.push('second-end')
      })
    })

    void trackPendingIndexWrite(firstWrite)
    void trackPendingIndexWrite(secondWrite)

    await flush()
    expect(firstWrite).toHaveBeenCalledTimes(1)
    expect(secondWrite).not.toHaveBeenCalled()
    expect(order).toEqual(['first-start'])

    resolveFirst!()
    await waitForPendingSessionIndexWrite()

    expect(secondWrite).toHaveBeenCalledTimes(1)
    // First fully finished before second started → no overlap.
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end'])
  })

  it('awaits a write queued while the close path is draining', async () => {
    // Regression for the shutdown race: a trackPendingIndexWrite() scheduled
    // after waitForPendingSessionIndexWrite() started must still be awaited
    // before the wait resolves — otherwise window.destroy() loses the last
    // history update.
    let resolveFirst: () => void
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    let resolveSecond: () => void
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve
    })

    void trackPendingIndexWrite(() => first)

    let waitDone = false
    void waitForPendingSessionIndexWrite().then(() => {
      waitDone = true
    })
    await flush()
    expect(waitDone).toBe(false)

    // While the first write is still in flight, queue a second write (a final
    // persistSession firing during shutdown).
    void trackPendingIndexWrite(() => second)

    // Finishing the first write must NOT release the close wait — the queued
    // second write is still pending.
    resolveFirst!()
    await flush()
    expect(waitDone).toBe(false)

    resolveSecond!()
    await waitForPendingSessionIndexWrite()
    expect(waitDone).toBe(true)
  })
})

describe('scopeSessionIndex', () => {
  function entry(id: string, projectId: string, cwd: string): SessionIndexEntry {
    return {
      id,
      agentId: 'a',
      title: id,
      cwd,
      projectId,
      createdAt: 0,
      lastActivityAt: 0,
      messageCount: 0,
      status: 'active'
    }
  }

  it('returns [] when projectId or cwd is empty', () => {
    const entries = [entry('s1', 'p1', '/a')]
    expect(scopeSessionIndex(entries, '', '/a')).toEqual([])
    expect(scopeSessionIndex(entries, 'p1', '')).toEqual([])
    expect(scopeSessionIndex(entries, '', '')).toEqual([])
  })

  it('returns exact (projectId, cwd) matches', () => {
    const entries = [entry('s1', 'p1', '/a'), entry('s2', 'p1', '/b'), entry('s3', 'p2', '/a')]
    expect(scopeSessionIndex(entries, 'p1', '/a').map((e) => e.id)).toEqual(['s1'])
  })

  it('falls back to projectId-only matching when no exact cwd match exists', () => {
    // Regression: a chat whose worktree/cwd drifted since it was created must
    // still be reachable instead of silently hidden.
    const entries = [
      entry('s1', 'p1', '/old-cwd'),
      entry('s2', 'p1', '/also-old'),
      entry('s3', 'p2', '/a')
    ]
    expect(
      scopeSessionIndex(entries, 'p1', '/a')
        .map((e) => e.id)
        .sort()
    ).toEqual(['s1', 's2'])
  })

  it('does not fall back when exact matches exist', () => {
    const entries = [entry('s1', 'p1', '/a'), entry('s2', 'p1', '/other')]
    // Exact match present → only the exact entry is returned (no fallback).
    expect(scopeSessionIndex(entries, 'p1', '/a').map((e) => e.id)).toEqual(['s1'])
  })

  it('returns [] when no entry matches projectId at all', () => {
    const entries = [entry('s1', 'p2', '/a')]
    expect(scopeSessionIndex(entries, 'p1', '/a')).toEqual([])
  })
})

describe('loadSessionPayload — server branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockTransport.historyMode.mockReturnValue('tauri_store')
  })

  it('fetches the full transcript via getSessionPayload (not messages: [])', async () => {
    mockTransport.historyMode.mockReturnValue('server')
    const fullPayload = {
      metadata: {
        id: 's-9',
        agentId: 'a',
        title: 'Chat',
        cwd: '/c',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 2,
        status: 'closed' as const
      },
      messages: [msg('user', 'hi'), msg('agent', 'hello')]
    }
    mockTransport.getSessionPayload.mockResolvedValue(fullPayload)
    const result = await loadSessionPayload('s-9')
    expect(mockTransport.getSessionPayload).toHaveBeenCalledWith('s-9')
    expect(mockTransport.openPersistedSession).not.toHaveBeenCalled()
    expect(result).toEqual(fullPayload)
    expect(result?.messages).toHaveLength(2)
  })

  it('returns null when getSessionPayload returns null (not_found)', async () => {
    mockTransport.historyMode.mockReturnValue('server')
    mockTransport.getSessionPayload.mockResolvedValue(null)
    expect(await loadSessionPayload('missing')).toBeNull()
  })
})

describe('toPersistedSessionSummaries', () => {
  it('converts renderer SessionIndexEntry[] to wire PersistedSessionSummary[]', () => {
    const entries: SessionIndexEntry[] = [
      {
        id: 's-1',
        agentId: 'a1',
        agentConfigId: 'cfg-1',
        title: 'Chat',
        cwd: '/c',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 3,
        status: 'active'
      }
    ]
    const summaries = toPersistedSessionSummaries(entries)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toEqual({
      storageKey: 's-1',
      sessionId: 's-1',
      stableAgentNamespace: 'config:cfg-1',
      runtimeAgentId: 'a1',
      projectId: 'p1',
      cwd: '/c',
      title: 'Chat',
      createdAt: 1,
      lastActivityAt: 2,
      status: 'active',
      messageCount: 3,
      toolCount: 0,
      lastSeq: 0,
      resumeEligible: true
    })
  })

  it('maps initializing status to active and derives resumeEligible from agentConfigId', () => {
    const summaries = toPersistedSessionSummaries([
      {
        id: 's-2',
        agentId: '',
        title: 'T',
        cwd: '/c',
        projectId: 'p1',
        createdAt: 0,
        lastActivityAt: 0,
        messageCount: 0,
        status: 'initializing'
      }
    ])
    expect(summaries[0].status).toBe('active')
    expect(summaries[0].resumeEligible).toBe(false)
    expect(summaries[0].stableAgentNamespace).toBeNull()
    expect(summaries[0].runtimeAgentId).toBeUndefined()
  })
})
