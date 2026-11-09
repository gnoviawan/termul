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

const message = (id: string) => ({
  id,
  role: 'assistant' as const,
  content: `msg-${id}`,
  timestamp: 1
})

const payloadOf = (ids: string[]) => ({ messages: ids.map(message), toolCalls: [] })

const entry = (id: string, continuedFrom?: string) =>
  mockSessionIndexEntry({ id, continuedFrom, title: `Chat ${id}` })

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
  })

  it('prefers the loaded transcript when its splice already covers the chain', async () => {
    useAcpStore.setState({
      sessionIndex: [entry('src'), entry('dst', 'src')],
      messages: { dst: [message('src-1'), message('sw-sep'), message('dst-1')] },
      agentSwitches: { dst: [{ newSessionId: 'dst' }] },
      toolCalls: { dst: [] }
    })
    const transcript = await readConversationTranscript('dst')
    expect(mockHistoryApi.getTail).not.toHaveBeenCalled()
    expect(transcript?.messages).toHaveLength(3)
  })

  it('falls back to member reads when the loaded splice is incomplete', async () => {
    // A 3-hop chain whose loaded terminal only carries one marker: the
    // persisted member reads recover the missing ancestor.
    useAcpStore.setState({
      sessionIndex: [entry('a'), entry('b', 'a'), entry('c', 'b')],
      messages: { c: [message('b-1'), message('c-1')] },
      agentSwitches: { c: [{ newSessionId: 'c' }] },
      toolCalls: {}
    })
    mockHistoryApi.getTail.mockImplementation((id: string) =>
      Promise.resolve(payloadOf([`${id}-1`]))
    )
    const transcript = await readConversationTranscript('c')
    expect(mockHistoryApi.getTail).toHaveBeenCalledTimes(3)
    expect(transcript?.messages.map((m) => m.id)).toEqual(['a-1', 'b-1', 'c-1'])
  })

  it('returns null for a live_only transport', async () => {
    mockTransport.historyMode.mockReturnValue('live_only')
    const transcript = await readConversationTranscript('a')
    expect(transcript).toBeNull()
  })
})
