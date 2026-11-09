import { beforeEach, describe, expect, type Mock, vi } from 'vitest'
import { mockSessionIndexEntry } from '@/lib/test-utils/acp'
import { useAcpStore } from '@/stores/acp-store'
import { readConversationTranscript } from './conversation-transcript'

const { mockTransport, mockHistoryApi } = vi.hoisted(() => {
  const mockTransport: {
    historyMode: Mock
    getSessionPayloadTail: Mock
  } = {
    historyMode: vi.fn(() => 'tauri_store' as const),
    getSessionPayloadTail: vi.fn()
  }
  const mockHistoryApi = { getTail: vi.fn() }
  return { mockTransport, mockHistoryApi }
})

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

const message = (id: string, seq = 1) => ({
  id,
  role: 'assistant' as const,
  content: `msg-${id}`,
  seq,
  timestamp: 1
})

const payloadOf = (ids: string[], seqs?: number[]) => ({
  messages: ids.map((id, i) => message(id, seqs?.[i] ?? i + 1)),
  toolCalls: []
})

const entry = (id: string, continuedFrom?: string, projectId = 'p1', lastSeq = 0) =>
  mockSessionIndexEntry({ id, continuedFrom, title: `Chat ${id}`, projectId, lastSeq })

beforeEach(() => {
  vi.clearAllMocks()
  mockTransport.historyMode.mockReturnValue('tauri_store')
  mockHistoryApi.getTail.mockResolvedValue(null)
  useAcpStore.setState({
    sessionIndex: [],
    sessions: {},
    messages: {},
    toolCalls: {},
    agentSwitches: {}
  })
})

describe('readConversationTranscript', () => {
  it('reads a standalone session tail only', async () => {
    useAcpStore.setState({ sessionIndex: [entry('a')] })
    mockHistoryApi.getTail.mockResolvedValue(payloadOf(['a1']))
    const transcript = await readConversationTranscript('a')
    expect(mockHistoryApi.getTail).toHaveBeenCalledWith('a', expect.any(Number))
    expect(mockHistoryApi.getTail).toHaveBeenCalledTimes(1)
    expect(transcript?.messages.map((m) => m.id)).toEqual(['a1'])
  })

  it('reads every chain member oldest to newest when the terminal is not loaded', async () => {
    useAcpStore.setState({
      sessionIndex: [entry('src'), entry('dst', 'src')]
    })
    mockHistoryApi.getTail.mockImplementation((id: string) =>
      Promise.resolve(payloadOf([`${id}-1`]))
    )
    const transcript = await readConversationTranscript('dst')
    expect(mockHistoryApi.getTail).toHaveBeenCalledTimes(2)
    expect(transcript?.messages.map((m) => m.id)).toEqual(['src-1', 'dst-1'])
    expect(transcript?.partial).toBeUndefined()
  })

  it('re-stamps member seqs into increasing bands so merged order survives the seq-first sort', async () => {
    useAcpStore.setState({
      sessionIndex: [entry('src', undefined, 'p1', 50), entry('dst', 'src', 'p1', 30)]
    })
    mockHistoryApi.getTail.mockImplementation((id: string) =>
      Promise.resolve(payloadOf(id === 'src' ? ['s1', 's2'] : ['d1'], [1, 2]))
    )
    const transcript = await readConversationTranscript('dst')
    const seqs = transcript?.messages.map((m) => m.seq ?? 0)
    expect(seqs).toEqual([1, 2, 51])
  })

  it('prefers the loaded transcript when its splice covers every ancestor band', async () => {
    useAcpStore.setState({
      sessionIndex: [entry('src'), entry('dst', 'src')],
      messages: {
        dst: [message('switch-splice:src:s1', -50), message('dst-1')]
      },
      agentSwitches: { dst: [{ newSessionId: 'dst' }] },
      toolCalls: { dst: [] }
    })
    const transcript = await readConversationTranscript('dst')
    expect(mockHistoryApi.getTail).not.toHaveBeenCalled()
    expect(transcript?.messages).toHaveLength(2)
  })

  it('falls back to member reads when the loaded band is missing despite the marker', async () => {
    // Marker recorded but the band never spliced (failed reload): the loaded
    // transcript has only own turns, so member reads must recover the source.
    useAcpStore.setState({
      sessionIndex: [entry('src'), entry('dst', 'src')],
      messages: { dst: [message('dst-1')] },
      agentSwitches: { dst: [{ newSessionId: 'dst' }] },
      toolCalls: {}
    })
    mockHistoryApi.getTail.mockImplementation((id: string) =>
      Promise.resolve(payloadOf([`${id}-1`]))
    )
    const transcript = await readConversationTranscript('dst')
    expect(transcript?.messages.map((m) => m.id)).toEqual(['src-1', 'dst-1'])
  })

  it('marks the transcript partial when a chain member is unreadable', async () => {
    useAcpStore.setState({
      sessionIndex: [entry('src'), entry('dst', 'src')]
    })
    mockHistoryApi.getTail.mockImplementation((id: string) =>
      Promise.resolve(id === 'dst' ? payloadOf(['dst-1']) : null)
    )
    const transcript = await readConversationTranscript('dst')
    expect(transcript?.partial).toBe(true)
    expect(transcript?.messages.map((m) => m.id)).toEqual(['dst-1'])
  })

  it('prefers a loaded member’s own turns over its persisted payload', async () => {
    useAcpStore.setState({
      sessionIndex: [entry('src'), entry('dst', 'src')],
      // src is live-loaded with an outgoing band spliced in — own turns only.
      messages: { src: [message('own-1'), message('switch-splice:older:x', -9)] }
    })
    mockHistoryApi.getTail.mockImplementation((id: string) =>
      Promise.resolve(id === 'dst' ? payloadOf(['dst-1']) : null)
    )
    const transcript = await readConversationTranscript('dst')
    expect(transcript?.messages.map((m) => m.id)).toEqual(['own-1', 'dst-1'])
  })

  it('does not read a chain member in another project', async () => {
    useAcpStore.setState({
      sessionIndex: [entry('src', undefined, 'p2'), entry('dst', 'src', 'p1')]
    })
    mockHistoryApi.getTail.mockImplementation((id: string) =>
      Promise.resolve(payloadOf([`${id}-1`]))
    )
    const transcript = await readConversationTranscript('dst')
    expect(mockHistoryApi.getTail).toHaveBeenCalledTimes(1)
    expect(mockHistoryApi.getTail).toHaveBeenCalledWith('dst', expect.any(Number))
    expect(transcript?.messages.map((m) => m.id)).toEqual(['dst-1'])
  })

  it('returns null for a live_only transport', async () => {
    mockTransport.historyMode.mockReturnValue('live_only')
    const transcript = await readConversationTranscript('a')
    expect(transcript).toBeNull()
  })
})
