import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acpApi } from '@/lib/acp-api'
import { useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { reloadAgentChat, reloadChatBlockedReason } from './reload-chat'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

const closeSession = vi.spyOn(acpApi, 'closeSession')

const session = (
  id: string,
  overrides: { busy?: boolean; status?: 'active' | 'error' | 'closed'; agentId?: string } = {}
) => ({
  id,
  agentId: overrides.agentId ?? 'agent-1',
  cwd: '/work',
  projectId: 'p1',
  status: overrides.status ?? ('active' as const),
  title: null,
  activeTurn: Boolean(overrides.busy),
  openTurnId: overrides.busy ? 'turn-1' : null,
  modes: null,
  models: null,
  configOptions: [],
  lastError: null,
  createdAt: 1
})

beforeEach(() => {
  vi.clearAllMocks()
  closeSession.mockResolvedValue(undefined)
  useAcpStore.setState({
    ...FRESH,
    flushLiveSessionSaves: vi.fn(),
    killAgent: vi.fn(async () => undefined),
    openHistorySession: vi.fn(async (id: string) => {
      useAcpStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          [id]: { ...s.sessions[id], status: 'active', agentId: 'agent-new' }
        }
      }))
    }),
    agents: {
      'agent-1': { id: 'agent-1', capabilities: { loadSession: true } }
    },
    mcpServers: [
      { id: 'files', type: 'stdio', name: 'files', command: 'files-mcp', enabled: true }
    ],
    sessions: {
      s1: session('s1'),
      s2: session('s2')
    },
    messages: {
      s1: [{ id: 'm1', role: 'user', blocks: [], streaming: false, timestamp: 1 }]
    },
    sessionIndex: [
      {
        id: 's1',
        agentId: 'agent-1',
        agentConfigId: 'cfg-1',
        title: 's1',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 1,
        messageCount: 1,
        status: 'active'
      }
    ],
    reloadingChatIds: {},
    agentReloadMarks: {}
  } as never)
})

describe('reloadAgentChat', () => {
  it('stays blocked while a reply is running', async () => {
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, s1: session('s1', { busy: true }) }
    }))
    expect(reloadChatBlockedReason(useAcpStore.getState(), 's1')).toBe(
      'Wait until this reply finishes.'
    )
    await expect(reloadAgentChat('s1')).rejects.toThrow('Wait until this reply finishes.')
    expect(useAcpStore.getState().killAgent).not.toHaveBeenCalled()
  })

  it('kills the process when this chat is the only one, and does not resend', async () => {
    useAcpStore.setState((s) => ({ sessions: { s1: s.sessions.s1 } }))
    await reloadAgentChat('s1')
    expect(useAcpStore.getState().killAgent).toHaveBeenCalledWith('agent-1')
    expect(closeSession).not.toHaveBeenCalled()
    expect(useAcpStore.getState().openHistorySession).toHaveBeenCalledWith('s1', {
      mcpServers: [{ type: 'stdio', name: 'files', command: 'files-mcp', args: [], env: [] }],
      forceNewAgent: true
    })
    expect(useAcpStore.getState().agentReloadMarks.s1).toEqual({ afterMessageId: 'm1' })
    expect(useAcpStore.getState().reloadingChatIds.s1).toBeUndefined()
    expect(useAcpStore.getState().sessions.s2).toBeUndefined()
  })

  it('leaves sibling chats on the old process', async () => {
    await reloadAgentChat('s1')
    expect(useAcpStore.getState().killAgent).not.toHaveBeenCalled()
    expect(closeSession).toHaveBeenCalledWith('agent-1', 's1')
    expect(useAcpStore.getState().sessions.s2.status).toBe('active')
    expect(useAcpStore.getState().sessions.s2.agentId).toBe('agent-1')
    expect(useAcpStore.getState().openHistorySession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ forceNewAgent: true })
    )
  })

  it('does not mark the chat reloaded when the reopen fails', async () => {
    useAcpStore.setState({
      sessions: { s1: session('s1') },
      openHistorySession: vi.fn(async () => {
        throw new Error('Could not start a new agent for this chat.')
      })
    } as never)
    await reloadAgentChat('s1')
    expect(useAcpStore.getState().agentReloadMarks.s1).toBeUndefined()
    expect(useAcpStore.getState().sessions.s1.status).toBe('active')
  })

  it('refuses an agent that cannot reopen a session', async () => {
    useAcpStore.setState({
      agents: { 'agent-1': { id: 'agent-1', capabilities: { loadSession: false } } }
    })
    await expect(reloadAgentChat('s1')).rejects.toThrow('cannot reload a chat')
    expect(useAcpStore.getState().killAgent).not.toHaveBeenCalled()
    expect(useAcpStore.getState().openHistorySession).not.toHaveBeenCalled()
  })
})
