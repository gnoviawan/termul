import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockTransport, mockHistoryApi } = vi.hoisted(() => ({
  mockTransport: {
    historyMode: vi.fn(() => 'tauri_store' as const),
    listPersistedSessions: vi.fn(),
    openPersistedSession: vi.fn(),
    getSessionPayload: vi.fn()
  },
  mockHistoryApi: {
    list: vi.fn(),
    get: vi.fn(),
    listLegacy: vi.fn(),
    getLegacy: vi.fn(),
    save: vi.fn(),
    delete: vi.fn(),
    flush: vi.fn(),
    markLegacyImportComplete: vi.fn()
  }
}))

vi.mock('@/lib/acp-transport', () => ({ getAcpTransport: () => mockTransport }))
vi.mock('@/lib/acp-history-api', () => ({ acpHistoryApi: mockHistoryApi }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: vi.fn(),
    write: vi.fn(),
    writeDebounced: vi.fn(),
    delete: vi.fn()
  }
}))

import type { ToolCall } from '@/lib/acp-api'
import { persistenceApi } from '@/lib/api'
import type { ChatMessage } from '@/stores/acp-store'
import {
  _clearPayloadCacheForTesting,
  _resetPendingIndexWriteTrackerForTesting,
  deriveTitle,
  flushSessionHistory,
  getCachedSessionPayload,
  groupSessionsByRecency,
  INACTIVE_PAYLOAD_CACHE_BUDGET,
  loadSessionIndex,
  loadSessionPayload,
  markSessionPayloadPinned,
  maxPayloadSeq,
  PERSISTED_TOOL_CALL_BYTE_BUDGET,
  PERSISTED_TOOL_CALLS_LIMIT,
  queueSessionPayloadDelete,
  queueSessionPayloadSave,
  restoredToolCalls,
  runHistoryWipeMigration,
  SESSION_INDEX_KEY,
  type SessionIndexEntry,
  type SessionPayload,
  sanitizeToolCallsForPersistence,
  saveSessionPayload,
  scopeSessionIndex,
  sessionPayloadKey,
  setCachedSessionPayload,
  toPersistedSessionSummaries,
  trackPendingIndexWrite,
  unpinSessionPayload,
  waitForPendingSessionIndexWrite
} from './acp-history-persistence'

function msg(role: ChatMessage['role'], text: string): ChatMessage {
  return { id: `m-${text}`, role, blocks: [{ type: 'text', text }], streaming: false, timestamp: 0 }
}

function entry(id: string, overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry {
  return {
    id,
    agentId: 'agent-1',
    agentConfigId: 'cfg-1',
    title: `Chat ${id}`,
    cwd: '/project',
    projectId: 'project-1',
    createdAt: 1,
    lastActivityAt: 2,
    messageCount: 0,
    status: 'closed',
    ...overrides
  }
}

function payload(id: string, messages: ChatMessage[] = []): SessionPayload {
  return { metadata: entry(id, { messageCount: messages.length }), messages }
}

beforeEach(() => {
  vi.clearAllMocks()
  _clearPayloadCacheForTesting()
  _resetPendingIndexWriteTrackerForTesting()
  mockTransport.historyMode.mockReturnValue('tauri_store')
  mockHistoryApi.list.mockResolvedValue({ sessions: [], legacyImportComplete: false })
  mockHistoryApi.get.mockResolvedValue(null)
  mockHistoryApi.listLegacy.mockResolvedValue({ sessions: [], legacyImportComplete: false })
  mockHistoryApi.getLegacy.mockResolvedValue(null)
  mockHistoryApi.save.mockResolvedValue(undefined)
  mockHistoryApi.delete.mockResolvedValue(undefined)
  mockHistoryApi.flush.mockResolvedValue(undefined)
  mockHistoryApi.markLegacyImportComplete.mockResolvedValue(undefined)
  ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: false,
    code: 'KEY_NOT_FOUND',
    error: 'not found'
  })
  ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })
  ;(persistenceApi.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true })
})

describe('pure history helpers', () => {
  it('derives, truncates, and falls back for titles', () => {
    expect(deriveTitle([msg('agent', 'hi'), msg('user', 'Refactor auth')], 'fallback')).toBe(
      'Refactor auth'
    )
    expect(deriveTitle([msg('user', 'x'.repeat(60))], 'fallback')).toBe(`${'x'.repeat(40)}…`)
    expect(deriveTitle([msg('agent', 'hello')], 'fallback')).toBe('fallback')
  })

  it('groups by recency and scopes by project/cwd with fallback', () => {
    const now = new Date('2026-05-30T12:00:00').getTime()
    const groups = groupSessionsByRecency(
      [
        entry('today', { lastActivityAt: new Date('2026-05-30T11:00:00').getTime() }),
        entry('yesterday', { lastActivityAt: new Date('2026-05-29T11:00:00').getTime() }),
        entry('old', { lastActivityAt: new Date('2026-05-01T11:00:00').getTime() })
      ],
      now
    )
    expect(groups.map(({ group }) => group)).toEqual(['Today', 'Yesterday', 'Earlier'])

    const entries = [
      entry('exact', { cwd: '/a' }),
      entry('other-cwd', { cwd: '/b' }),
      entry('other-project', { projectId: 'project-2', cwd: '/a' })
    ]
    expect(scopeSessionIndex(entries, 'project-1', '/a').map(({ id }) => id)).toEqual(['exact'])
    expect(scopeSessionIndex(entries, 'project-1', '/missing').map(({ id }) => id)).toEqual([
      'exact',
      'other-cwd'
    ])
    expect(scopeSessionIndex(entries, '', '/a')).toEqual([])
  })

  it('preserves the existing browser summary wire shape', () => {
    expect(toPersistedSessionSummaries([entry('s-1', { status: 'initializing' })])[0]).toEqual(
      expect.objectContaining({
        sessionId: 's-1',
        stableAgentNamespace: 'config:cfg-1',
        status: 'active',
        resumeEligible: true
      })
    )
  })

  it('surfaces the real persisted lastSeq and degrades to 0 when absent', () => {
    // R3 / parent-spec R2 index-list completeness: the summary must carry the
    // real max message seq when the index entry has it.
    const withSeq = toPersistedSessionSummaries([entry('seq-7', { lastSeq: 7 })])[0]
    expect(withSeq.lastSeq).toBe(7)

    // Absent (old save or Rust index that does not surface it) → 0 (pre-R3).
    const withoutSeq = toPersistedSessionSummaries([entry('seq-0')])[0]
    expect(withoutSeq.lastSeq).toBe(0)
  })
})

describe('durable tool-call sanitization', () => {
  function toolCall(overrides: Partial<ToolCall> = {}): ToolCall {
    return {
      toolCallId: 'tc-1',
      title: 'Read file',
      kind: 'read',
      status: 'completed',
      timestamp: 100,
      seq: 5,
      rawInput: { path: '/a.ts' },
      rawOutput: 'huge output',
      ...overrides
    }
  }

  it('returns undefined for absent or empty lists so the field is omitted', () => {
    expect(sanitizeToolCallsForPersistence(undefined)).toBeUndefined()
    expect(sanitizeToolCallsForPersistence([])).toBeUndefined()
  })

  it('strips rawOutput but keeps summary fields and timeline stamps', () => {
    const [clean] = sanitizeToolCallsForPersistence([toolCall()])!
    expect(clean.rawOutput).toBeUndefined()
    expect(clean).toMatchObject({
      toolCallId: 'tc-1',
      title: 'Read file',
      kind: 'read',
      status: 'completed',
      timestamp: 100,
      seq: 5,
      rawInput: { path: '/a.ts' }
    })
  })

  it('keeps structured content and rawInput within the byte budget', () => {
    const [clean] = sanitizeToolCallsForPersistence([
      toolCall({
        content: [{ type: 'text', text: 'short' }],
        rawInput: { command: 'ls' }
      })
    ])!
    expect(clean.content).toEqual([{ type: 'text', text: 'short' }])
    expect(clean.rawInput).toEqual({ command: 'ls' })
  })

  it('degrades over-budget calls to the structural subset', () => {
    const huge = 'x'.repeat(PERSISTED_TOOL_CALL_BYTE_BUDGET + 1)
    const [clean] = sanitizeToolCallsForPersistence([
      toolCall({ rawInput: { path: '/big.ts', blob: huge } })
    ])!
    expect(clean.rawInput).toBeUndefined()
    expect(clean.content).toBeUndefined()
    expect(clean).toMatchObject({ toolCallId: 'tc-1', title: 'Read file', kind: 'read', seq: 5 })
  })

  it('falls back to the structural subset for non-serializable fields', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const [clean] = sanitizeToolCallsForPersistence([toolCall({ rawInput: circular })])!
    expect(clean.rawInput).toBeUndefined()
    expect(clean).toMatchObject({ toolCallId: 'tc-1', status: 'completed', seq: 5 })
  })

  it('persists mid-flight statuses as failed so restored cards do not spin forever', () => {
    const pending = sanitizeToolCallsForPersistence([toolCall({ status: 'pending' })])!
    const inProgress = sanitizeToolCallsForPersistence([toolCall({ status: 'in_progress' })])!
    expect(pending[0].status).toBe('failed')
    expect(inProgress[0].status).toBe('failed')
    const completed = sanitizeToolCallsForPersistence([toolCall({ status: 'completed' })])!
    expect(completed[0].status).toBe('completed')
  })

  it('bounds agent-controlled titles so the degraded subset stays bounded', () => {
    const hugeTitle = 't'.repeat(5000)
    const [clean] = sanitizeToolCallsForPersistence([
      toolCall({
        title: hugeTitle,
        rawInput: { blob: 'x'.repeat(PERSISTED_TOOL_CALL_BYTE_BUDGET) }
      })
    ])!
    expect(clean.title!.length).toBeLessThanOrEqual(201)
  })

  it('drops unknown agent fields at the persistence boundary', () => {
    const [clean] = sanitizeToolCallsForPersistence([
      toolCall({ vendorBlob: 'should not survive' })
    ])!
    expect(clean.vendorBlob).toBeUndefined()
    expect(clean.rawOutput).toBeUndefined()
  })

  it('keeps only the most recent calls per session (recency bound)', () => {
    const calls = Array.from({ length: PERSISTED_TOOL_CALLS_LIMIT + 10 }, (_, index) => ({
      toolCallId: `tc-${index}`,
      seq: index + 1
    }))
    const clean = sanitizeToolCallsForPersistence(calls)!
    expect(clean).toHaveLength(PERSISTED_TOOL_CALLS_LIMIT)
    expect(clean[0].toolCallId).toBe('tc-10')
    expect(clean[clean.length - 1].toolCallId).toBe(`tc-${PERSISTED_TOOL_CALLS_LIMIT + 9}`)
  })

  it('tolerates non-array input without throwing', () => {
    expect(sanitizeToolCallsForPersistence('corrupt' as unknown as ToolCall[])).toBeUndefined()
  })

  it('drops calls whose structural subset still exceeds the budget (oversized id)', () => {
    const oversizedId = 'tc-'.concat('x'.repeat(PERSISTED_TOOL_CALL_BYTE_BUDGET + 1))
    const clean = sanitizeToolCallsForPersistence([
      toolCall({ toolCallId: oversizedId }),
      toolCall({ toolCallId: 'tc-ok' })
    ])!
    expect(clean).toHaveLength(1)
    expect(clean[0].toolCallId).toBe('tc-ok')
  })

  it('returns undefined when every call is dropped for exceeding the budget', () => {
    const oversizedId = 'tc-'.concat('x'.repeat(PERSISTED_TOOL_CALL_BYTE_BUDGET + 1))
    expect(sanitizeToolCallsForPersistence([toolCall({ toolCallId: oversizedId })])).toBeUndefined()
  })
})

describe('payload restore helpers', () => {
  it('maxPayloadSeq folds message and tool-call seqs', () => {
    expect(
      maxPayloadSeq({
        messages: [{ id: 'm', role: 'user', blocks: [], streaming: false, timestamp: 0, seq: 3 }],
        toolCalls: [{ toolCallId: 'tc', seq: 7 }]
      })
    ).toBe(7)
    expect(
      maxPayloadSeq({
        messages: [{ id: 'm', role: 'user', blocks: [], streaming: false, timestamp: 0, seq: 9 }],
        toolCalls: [{ toolCallId: 'tc', seq: 2 }]
      })
    ).toBe(9)
  })

  it('restore helpers degrade corrupt toolCalls shapes instead of throwing', () => {
    const corrupt = { toolCalls: 'not-an-array' as unknown as ToolCall[] }
    expect(maxPayloadSeq({ messages: [], ...corrupt })).toBe(0)
    expect(restoredToolCalls(corrupt)).toEqual([])
    expect(restoredToolCalls({})).toEqual([])
  })

  it('restore helpers skip null and malformed entries inside the array', () => {
    const valid = { toolCallId: 'tc-valid', seq: 4 }
    const junk = [
      null,
      42,
      'tc-string',
      { seq: 3 },
      { toolCallId: '' },
      valid
    ] as unknown as ToolCall[]
    expect(maxPayloadSeq({ messages: [], toolCalls: junk })).toBe(4)
    expect(restoredToolCalls({ toolCalls: junk })).toEqual([valid])
  })

  it('maxPayloadSeq ignores non-finite seqs instead of poisoning the rebase', () => {
    const corrupt = {
      toolCalls: [{ toolCallId: 'tc-nan', seq: Number.NaN }] as unknown as ToolCall[]
    }
    expect(maxPayloadSeq({ messages: [], ...corrupt })).toBe(0)
  })
})

describe('provider routing', () => {
  it('loads desktop index from the Rust facade, including fresh empty state', async () => {
    mockHistoryApi.list.mockResolvedValueOnce({ sessions: [], legacyImportComplete: false })
    await expect(loadSessionIndex()).resolves.toEqual([])
    expect(mockHistoryApi.list).toHaveBeenCalledTimes(1)
    expect(persistenceApi.read).not.toHaveBeenCalled()

    mockHistoryApi.list.mockResolvedValueOnce({
      sessions: [entry('stored')],
      legacyImportComplete: true
    })
    await expect(loadSessionIndex()).resolves.toEqual([entry('stored')])
  })

  it('keeps standalone server and live-only behavior unchanged', async () => {
    mockTransport.historyMode.mockReturnValue('server')
    mockTransport.listPersistedSessions.mockResolvedValue([
      {
        storageKey: 'opaque',
        sessionId: 'server-1',
        stableAgentNamespace: 'config:cfg-server',
        runtimeAgentId: 'runtime-old',
        projectId: 'project-1',
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
      expect.objectContaining({ id: 'server-1', agentConfigId: 'cfg-server' })
    ])
    expect(mockHistoryApi.list).not.toHaveBeenCalled()

    mockTransport.historyMode.mockReturnValue('live_only')
    await expect(loadSessionIndex()).resolves.toEqual([])
  })

  it('retires desktop payload writes (host-authored) but still routes flush', async () => {
    const stored = payload('desktop', [msg('user', 'hi')])
    await saveSessionPayload('desktop', stored)
    // CAP-2: the host event/session layer owns durable writes; the renderer
    // save path must not reach the store (the payload stays a local cache).
    expect(mockHistoryApi.save).not.toHaveBeenCalled()
    expect(getCachedSessionPayload('desktop')).toEqual(stored)

    await flushSessionHistory()
    expect(mockHistoryApi.flush).toHaveBeenCalledTimes(1)
  })

  it('always refetches payloads in server mode', async () => {
    mockTransport.historyMode.mockReturnValue('server')
    mockTransport.getSessionPayload
      .mockResolvedValueOnce(payload('server', [msg('user', 'one')]))
      .mockResolvedValueOnce(payload('server', [msg('user', 'two')]))
    expect((await loadSessionPayload('server'))?.messages[0].id).toBe('m-one')
    expect((await loadSessionPayload('server'))?.messages[0].id).toBe('m-two')
    expect(mockTransport.getSessionPayload).toHaveBeenCalledTimes(2)
  })
})

describe('bounded full-payload cache', () => {
  it('evicts least-recent inactive entries and reloads them from Rust', async () => {
    for (let index = 0; index <= INACTIVE_PAYLOAD_CACHE_BUDGET; index += 1) {
      setCachedSessionPayload(`s-${index}`, payload(`s-${index}`, [msg('user', `${index}`)]))
    }
    expect(getCachedSessionPayload('s-0')).toBeUndefined()

    mockHistoryApi.get.mockResolvedValueOnce(payload('s-0', [msg('user', 'reloaded')]))
    await expect(loadSessionPayload('s-0')).resolves.toEqual(
      payload('s-0', [msg('user', 'reloaded')])
    )
    expect(mockHistoryApi.get).toHaveBeenCalledWith('s-0')
  })

  it('pins trimmed live sessions in addition to the inactive budget', () => {
    markSessionPayloadPinned('pinned')
    setCachedSessionPayload('pinned', payload('pinned'))
    for (let index = 0; index <= INACTIVE_PAYLOAD_CACHE_BUDGET; index += 1) {
      setCachedSessionPayload(`inactive-${index}`, payload(`inactive-${index}`))
    }
    expect(getCachedSessionPayload('pinned')).toBeDefined()
    expect(getCachedSessionPayload('inactive-0')).toBeUndefined()
    unpinSessionPayload('pinned')
  })

  it('saveSessionPayload never reads or writes the store (host-authored history)', async () => {
    const retained = msg('agent', 'retained')
    const latest = msg('agent', 'latest')

    await saveSessionPayload('merge', payload('merge', [retained, latest]))

    expect(mockHistoryApi.save).not.toHaveBeenCalled()
    expect(mockHistoryApi.get).not.toHaveBeenCalled()
    expect(getCachedSessionPayload('merge')?.messages).toEqual([retained, latest])
  })
})

describe('legacy import', () => {
  const old1 = payload('old-1', [msg('user', 'one')])
  const old2 = payload('old-2', [msg('user', 'two'), msg('agent', 'reply')])
  const index = [old1.metadata, old2.metadata]

  function mockLegacyReads(): void {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, data: index })
      .mockResolvedValueOnce({ success: true, data: old1 })
      .mockResolvedValueOnce({ success: true, data: old2 })
  }

  it('round-trips every payload before deleting only ACP history keys', async () => {
    mockLegacyReads()
    mockHistoryApi.listLegacy
      .mockResolvedValueOnce({ sessions: [], legacyImportComplete: false })
      .mockResolvedValueOnce({ sessions: index, legacyImportComplete: false })
    mockHistoryApi.getLegacy.mockImplementation(async (id: string) =>
      id === 'old-1' ? old1 : old2
    )

    await runHistoryWipeMigration()

    expect(mockHistoryApi.save).toHaveBeenNthCalledWith(1, 'old-1', old1)
    expect(mockHistoryApi.save).toHaveBeenNthCalledWith(2, 'old-2', old2)
    expect(mockHistoryApi.getLegacy).toHaveBeenCalledWith('old-1')
    expect(mockHistoryApi.getLegacy).toHaveBeenCalledWith('old-2')
    expect(persistenceApi.delete).toHaveBeenCalledWith(sessionPayloadKey('old-1'))
    expect(persistenceApi.delete).toHaveBeenCalledWith(sessionPayloadKey('old-2'))
    expect(persistenceApi.delete).toHaveBeenCalledWith(SESSION_INDEX_KEY)
    expect(persistenceApi.delete).toHaveBeenCalledTimes(3)
    expect(mockHistoryApi.markLegacyImportComplete).toHaveBeenCalledTimes(1)
  })

  it('is idempotent when Rust marks legacy import complete', async () => {
    mockHistoryApi.listLegacy.mockResolvedValueOnce({
      sessions: index,
      legacyImportComplete: true
    })
    await runHistoryWipeMigration()
    expect(persistenceApi.read).not.toHaveBeenCalled()
    expect(mockHistoryApi.save).not.toHaveBeenCalled()
  })

  it('fails closed on a successful non-array legacy index', async () => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: true,
      data: { unexpected: true }
    })
    await expect(runHistoryWipeMigration()).rejects.toThrow('Legacy session index is not an array')
    expect(mockHistoryApi.save).not.toHaveBeenCalled()
  })

  it('fails closed when legacy index and payload ids differ', async () => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, data: index })
      .mockResolvedValueOnce({ success: true, data: payload('different') })
    await expect(runHistoryWipeMigration()).rejects.toThrow('Legacy payload id mismatch')
    expect(mockHistoryApi.save).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer differing durable payload on retry', async () => {
    mockLegacyReads()
    mockHistoryApi.listLegacy.mockResolvedValueOnce({
      sessions: [old1.metadata],
      legacyImportComplete: false
    })
    mockHistoryApi.getLegacy.mockResolvedValueOnce(payload('old-1', [msg('user', 'newer')]))
    await expect(runHistoryWipeMigration()).rejects.toThrow('Durable history differs')
    expect(mockHistoryApi.save).not.toHaveBeenCalled()
    expect(persistenceApi.delete).not.toHaveBeenCalled()
  })

  it('fails closed when any legacy payload cannot be read', async () => {
    ;(persistenceApi.read as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true, data: index })
      .mockResolvedValueOnce({ success: true, data: old1 })
      .mockResolvedValueOnce({ success: false, code: 'READ_ERROR', error: 'payload unavailable' })

    await expect(runHistoryWipeMigration()).rejects.toThrow('payload unavailable')
    expect(mockHistoryApi.save).not.toHaveBeenCalled()
    expect(persistenceApi.delete).not.toHaveBeenCalled()
  })

  it('fails closed when Rust verification fails and retains all legacy keys', async () => {
    mockLegacyReads()
    mockHistoryApi.listLegacy
      .mockResolvedValueOnce({ sessions: [], legacyImportComplete: false })
      .mockResolvedValueOnce({ sessions: [old1.metadata], legacyImportComplete: false })

    await expect(runHistoryWipeMigration()).rejects.toThrow('Legacy payload verification failed')
    expect(persistenceApi.delete).not.toHaveBeenCalled()
    expect(mockHistoryApi.markLegacyImportComplete).not.toHaveBeenCalled()
  })

  it('restores the complete legacy source if cleanup fails part-way', async () => {
    mockLegacyReads()
    mockHistoryApi.listLegacy
      .mockResolvedValueOnce({ sessions: [], legacyImportComplete: false })
      .mockResolvedValueOnce({ sessions: index, legacyImportComplete: false })
    mockHistoryApi.getLegacy.mockImplementation(async (id: string) =>
      id === 'old-1' ? old1 : old2
    )
    ;(persistenceApi.delete as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'delete failed', code: 'DELETE_ERROR' })

    await expect(runHistoryWipeMigration()).rejects.toThrow('delete failed')
    expect(persistenceApi.write).toHaveBeenCalledWith(sessionPayloadKey('old-1'), old1)
    expect(persistenceApi.write).toHaveBeenCalledWith(sessionPayloadKey('old-2'), old2)
    expect(persistenceApi.write).toHaveBeenCalledWith(SESSION_INDEX_KEY, index)
    expect(mockHistoryApi.markLegacyImportComplete).not.toHaveBeenCalled()
  })

  it('reports rollback write failures', async () => {
    mockLegacyReads()
    mockHistoryApi.listLegacy
      .mockResolvedValueOnce({ sessions: [], legacyImportComplete: false })
      .mockResolvedValueOnce({ sessions: index, legacyImportComplete: false })
    mockHistoryApi.getLegacy.mockImplementation(async (id: string) =>
      id === 'old-1' ? old1 : old2
    )
    ;(persistenceApi.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'delete failed',
      code: 'DELETE_ERROR'
    })
    ;(persistenceApi.write as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'rollback disk full',
      code: 'WRITE_ERROR'
    })
    await expect(runHistoryWipeMigration()).rejects.toThrow('rollback failed: rollback disk full')
  })
})

describe('serialized save/delete/close barriers', () => {
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('coalesces repeated queued saves to the latest pending payload (host-authored, no store)', async () => {
    const first = queueSessionPayloadSave('stream', payload('stream', [msg('user', 'one')]))
    await flush()
    const second = queueSessionPayloadSave('stream', payload('stream', [msg('user', 'two')]))
    const third = queueSessionPayloadSave('stream', payload('stream', [msg('user', 'three')]))
    await Promise.all([first, second, third, waitForPendingSessionIndexWrite()])
    // CAP-2: writes are host-owned — the queue still coalesces + resolves, but
    // nothing reaches the renderer-owned store; the last payload stays cached.
    expect(mockHistoryApi.save).not.toHaveBeenCalled()
    expect(getCachedSessionPayload('stream')?.messages).toEqual([msg('user', 'three')])
  })

  it('delete supersedes a stale pending save for the same session', async () => {
    const other = queueSessionPayloadSave('other', payload('other'))
    await flush()
    const stale = queueSessionPayloadSave('deleted', payload('deleted', [msg('user', 'stale')]))
    const deletion = queueSessionPayloadDelete('deleted')
    await Promise.all([other, stale, deletion, waitForPendingSessionIndexWrite()])
    expect(mockHistoryApi.save).not.toHaveBeenCalledWith('deleted', expect.anything())
    expect(mockHistoryApi.delete).toHaveBeenCalledWith('deleted')
  })

  it('rejects a queued delete failure and keeps the tombstone until a successful retry', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockHistoryApi.delete.mockRejectedValueOnce(new Error('delete failed'))

    await expect(queueSessionPayloadDelete('recreated')).rejects.toThrow('delete failed')
    await queueSessionPayloadSave('recreated', payload('recreated', [msg('user', 'blocked')]))
    // Tombstone still set: the queued save is dropped without caching.
    expect(getCachedSessionPayload('recreated')).toBeUndefined()

    await expect(queueSessionPayloadDelete('recreated')).resolves.toBeUndefined()
    await queueSessionPayloadSave('recreated', payload('recreated', [msg('user', 'saved')]))
    await waitForPendingSessionIndexWrite()
    // Tombstone cleared: the save applies (local cache only — host owns writes).
    expect(getCachedSessionPayload('recreated')?.messages).toEqual([msg('user', 'saved')])
    consoleError.mockRestore()
  })

  it('flush waits for a gated tracked write before invoking Rust flush', async () => {
    let releaseSave!: () => void
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    void trackPendingIndexWrite(() => saveGate)
    let flushed = false
    void flushSessionHistory().then(() => {
      flushed = true
    })
    await flush()
    expect(mockHistoryApi.flush).not.toHaveBeenCalled()
    expect(flushed).toBe(false)
    releaseSave()
    await waitForPendingSessionIndexWrite()
    await flush()
    expect(mockHistoryApi.flush).toHaveBeenCalledTimes(1)
    expect(flushed).toBe(true)
  })

  it('serializes operations so a queued stale save lands before delete', async () => {
    const order: string[] = []
    let releaseSave!: () => void
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    void trackPendingIndexWrite(async () => {
      order.push('save-start')
      await saveGate
      order.push('save-end')
    })
    void trackPendingIndexWrite(async () => {
      order.push('delete')
    })

    await flush()
    expect(order).toEqual(['save-start'])
    releaseSave()
    await waitForPendingSessionIndexWrite()
    expect(order).toEqual(['save-start', 'save-end', 'delete'])
  })

  it('awaits operations queued while the close barrier is draining', async () => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    void trackPendingIndexWrite(() => first)
    let settled = false
    void waitForPendingSessionIndexWrite().then(() => {
      settled = true
    })
    await flush()
    void trackPendingIndexWrite(() => second)
    releaseFirst()
    await flush()
    expect(settled).toBe(false)
    releaseSecond()
    await waitForPendingSessionIndexWrite()
    expect(settled).toBe(true)
  })

  it('logs write failures without breaking later operations', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    void trackPendingIndexWrite(() => Promise.reject(new Error('failed')))
    await expect(waitForPendingSessionIndexWrite()).resolves.toBeUndefined()
    expect(consoleError).toHaveBeenCalledWith(
      '[acp] failed to persist session history',
      expect.any(Error)
    )
    consoleError.mockRestore()
  })
})
