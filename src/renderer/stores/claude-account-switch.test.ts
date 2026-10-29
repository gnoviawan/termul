import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acpApi } from '@/lib/acp-api'
import { AcpTransportError } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { agentReuseKey } from '@/stores/acp-reuse-keys'
import {
  _addEphemeralSessionIdForTesting,
  _resetEphemeralSessionIdsForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import {
  buildProjectWorkspace,
  createProjectWorkspace,
  getAgentChatSessionIdsInAllTrees,
  useWorkspaceStore
} from '@/stores/workspace-store'
import {
  applyProjectClaudeAccount,
  CLAUDE_AGENT_CONFIG_ID,
  isClaudeSession,
  restartClaudeSession,
  switchProjectClaudeAccount
} from './claude-account-switch'

const { api } = vi.hoisted(() => ({ api: { setProjectAccount: vi.fn() } }))
vi.mock('@/lib/claude-accounts-api', () => ({ claudeAccountsApi: api }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/acp-api', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/acp-api')>()),
  acpRecordAgentSwitch: vi.fn(async () => undefined)
}))

const realKillAgent = useAcpStore.getState().killAgent
const killAgent = vi.fn()
const retryCrashedSession = vi.fn()
const cancelPrompt = vi.fn()

const session = (id: string, o: { projectId?: string; agentId?: string; busy?: boolean } = {}) => ({
  id,
  agentId: o.agentId ?? `agent-${id}`,
  cwd: '/work',
  projectId: o.projectId ?? 'office',
  status: 'active' as const,
  title: null,
  activeTurn: Boolean(o.busy),
  openTurnId: o.busy ? 'turn-1' : null,
  modes: null,
  models: null,
  configOptions: [],
  lastError: null,
  createdAt: 1
})

const indexEntry = (id: string, agentConfigId: string) => ({
  id,
  agentId: `agent-${id}`,
  agentConfigId,
  title: id,
  cwd: '/work',
  projectId: 'office',
  createdAt: 1,
  lastActivityAt: 1,
  messageCount: 1,
  status: 'active' as const
})

function openChatTabs(sessionIds: string[]): void {
  useWorkspaceStore.setState({ activeProjectId: '', parkedTrees: {}, ...createProjectWorkspace() })
  useWorkspaceStore.getState().activateProject(
    'office',
    buildProjectWorkspace({
      type: 'leaf',
      id: 'pane-1',
      activeTabId: `chat-${sessionIds[0]}`,
      tabs: sessionIds.map((sessionId) => ({
        type: 'agent-chat' as const,
        id: `chat-${sessionId}`,
        sessionId
      }))
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetEphemeralSessionIdsForTesting()
  useAgentChatLifetimeStore.setState({
    retainedByProject: {},
    activeSessionByProject: {},
    focusSessionByProject: {}
  })
  openChatTabs(['c1', 'c2', 'other', 'elsewhere'])
  killAgent.mockResolvedValue(undefined)
  retryCrashedSession.mockResolvedValue(undefined)
  cancelPrompt.mockImplementation(async (id: string) => {
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, [id]: { ...s.sessions[id], activeTurn: false, openTurnId: null } }
    }))
  })
  api.setProjectAccount.mockResolvedValue(true)
  useAcpStore.setState({
    ...FRESH,
    killAgent,
    retryCrashedSession,
    cancelPrompt,
    sessions: {
      c1: session('c1'),
      c2: session('c2', { busy: true }),
      other: session('other'),
      elsewhere: session('elsewhere', { projectId: 'side' })
    },
    sessionIndex: [
      indexEntry('c1', CLAUDE_AGENT_CONFIG_ID),
      indexEntry('c2', CLAUDE_AGENT_CONFIG_ID),
      indexEntry('other', 'acp-registry:gemini'),
      indexEntry('elsewhere', CLAUDE_AGENT_CONFIG_ID)
    ],
    sessionUsage: {
      c1: {
        used: 1,
        size: 10,
        baselineUsed: 1,
        updatedAt: 1,
        source: 'reported',
        rateLimit: {
          status: 'rejected',
          resetsAt: 1,
          kind: 'five_hour',
          percent: 100,
          overageInUse: false
        }
      }
    }
  } as never)
})

describe('claude account switch', () => {
  it('knows a managed Claude chat from its agent config', () => {
    const state = useAcpStore.getState()
    expect(isClaudeSession(state, 'c1')).toBe(true)
    expect(isClaudeSession(state, 'other')).toBe(false)
  })

  it('restarts an idle chat on a fresh process without resending, and clears the old limit', async () => {
    await expect(restartClaudeSession('c1')).resolves.toBe(true)
    expect(killAgent).toHaveBeenCalledWith('agent-c1')
    expect(retryCrashedSession).toHaveBeenCalledWith('c1', { resend: false })
    expect(killAgent.mock.invocationCallOrder[0]).toBeLessThan(
      retryCrashedSession.mock.invocationCallOrder[0]
    )
    expect(useAcpStore.getState().sessionUsage.c1?.rateLimit).toBeUndefined()
  })

  it('leaves a chat of another agent alone', async () => {
    await expect(restartClaudeSession('other')).resolves.toBe(false)
    expect(killAgent).not.toHaveBeenCalled()
  })

  it('waits for a busy chat to finish its turn', async () => {
    const restart = restartClaudeSession('c2')
    await Promise.resolve()
    expect(killAgent).not.toHaveBeenCalled()
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, c2: { ...s.sessions.c2, activeTurn: false, openTurnId: null } }
    }))
    await expect(restart).resolves.toBe(true)
    expect(retryCrashedSession).toHaveBeenCalledWith('c2', { resend: false })
  })

  it('cancels a held turn and resends when continuing after a limit', async () => {
    await restartClaudeSession('c2', { resend: true, cancelTurn: true })
    expect(cancelPrompt).toHaveBeenCalledWith('c2')
    expect(retryCrashedSession).toHaveBeenCalledWith('c2', { resend: true })
  })

  it('restarts only the Claude chats of the project, continuing the one that hit the limit', async () => {
    await expect(
      applyProjectClaudeAccount('office', { continueSessionIds: ['c2'] })
    ).resolves.toEqual(['c2'])
    const restarted = retryCrashedSession.mock.calls.map(([id, o]) => [id, o.resend])
    expect(restarted).toEqual(
      expect.arrayContaining([
        ['c1', false],
        ['c2', true]
      ])
    )
    expect(restarted).toHaveLength(2)
  })

  it('does not reopen a busy chat whose tab closed while it waited', async () => {
    await applyProjectClaudeAccount('office')
    openChatTabs(['c1'])
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, c2: { ...s.sessions.c2, activeTurn: false, openTurnId: null } }
    }))
    await vi.waitFor(() => expect(killAgent).toHaveBeenCalledWith('agent-c2'))
    expect(retryCrashedSession.mock.calls.map(([id]) => id)).toEqual(['c1'])
  })

  it('saves the project account on the host before restarting', async () => {
    await expect(switchProjectClaudeAccount('office', 'ab12')).resolves.toEqual([])
    expect(api.setProjectAccount).toHaveBeenCalledWith('office', 'ab12', {
      expectedAccountId: undefined
    })
    expect(api.setProjectAccount.mock.invocationCallOrder[0]).toBeLessThan(
      killAgent.mock.invocationCallOrder[0]
    )
  })
})

describe('claude account switch with chats that have no open tab', () => {
  const warmKey = agentReuseKey(CLAUDE_AGENT_CONFIG_ID, '/work', 'office')

  beforeEach(() => {
    vi.spyOn(acpApi, 'killAgent').mockResolvedValue(undefined)
    killAgent.mockImplementation((agentId: string) => realKillAgent(agentId))
    retryCrashedSession.mockImplementation(async (id: string) => {
      if (id === 'warm') throw new Error('unknown session')
    })
    _addEphemeralSessionIdForTesting('warm')
    useAcpStore.setState((s) => ({
      agents: { 'agent-warm': {} as never, 'agent-bg': {} as never, 'agent-c1': {} as never },
      agentStatus: {
        'agent-warm': 'connected',
        'agent-bg': 'connected',
        'agent-c1': 'connected'
      },
      configToLiveAgent: { [warmKey]: 'agent-warm' },
      preparedSessions: { [`${CLAUDE_AGENT_CONFIG_ID}\0/work\0`]: 'warm' },
      sessions: {
        c1: s.sessions.c1,
        warm: session('warm'),
        bg: session('bg')
      },
      sessionIndex: [
        indexEntry('c1', CLAUDE_AGENT_CONFIG_ID),
        indexEntry('bg', CLAUDE_AGENT_CONFIG_ID)
      ]
    }))
    openChatTabs(['c1'])
  })

  it('drops a warm-pool chat on the old account instead of restarting it', async () => {
    await applyProjectClaudeAccount('office')
    const state = useAcpStore.getState()
    expect(retryCrashedSession.mock.calls.map(([id]) => id)).toEqual(['c1'])
    expect(state.preparedSessions).toEqual({})
    expect(state.configToLiveAgent[warmKey]).toBeUndefined()
    expect(state.sessions.warm?.status).toBe('closed')
    expect(vi.mocked(logFrontendError).mock.calls.filter(([e]) => e.level === 'warn')).toEqual([])
  })

  it('stops the agent of an idle chat whose tab was closed and does not reopen it', async () => {
    await applyProjectClaudeAccount('office')
    expect(acpApi.killAgent).toHaveBeenCalledWith('agent-bg')
    expect(useAcpStore.getState().sessions.bg?.status).toBe('closed')
    expect(retryCrashedSession).not.toHaveBeenCalledWith('bg', expect.anything())
  })

  it('lets a closed-tab chat finish its turn before stopping its agent', async () => {
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, bg: { ...s.sessions.bg, activeTurn: true, openTurnId: 'turn-1' } }
    }))
    await applyProjectClaudeAccount('office')
    expect(acpApi.killAgent).not.toHaveBeenCalledWith('agent-bg')
    expect(useAcpStore.getState().sessions.bg?.status).toBe('active')
    useAcpStore.setState((s) => ({
      sessions: { ...s.sessions, bg: { ...s.sessions.bg, activeTurn: false, openTurnId: null } }
    }))
    await vi.waitFor(() => expect(acpApi.killAgent).toHaveBeenCalledWith('agent-bg'))
    expect(useAcpStore.getState().sessions.bg?.status).toBe('closed')
    expect(retryCrashedSession).not.toHaveBeenCalledWith('bg', expect.anything())
  })

  it('still restarts the open chat on the new account', async () => {
    await applyProjectClaudeAccount('office')
    expect(acpApi.killAgent).toHaveBeenCalledWith('agent-c1')
    expect(retryCrashedSession).toHaveBeenCalledWith('c1', { resend: false })
  })

  it('treats a chat kept for an off-screen project as open', async () => {
    useAgentChatLifetimeStore.getState().retainProjectChats('office', ['bg'])
    await applyProjectClaudeAccount('office')
    expect(retryCrashedSession).toHaveBeenCalledWith('bg', { resend: false })
  })
})

describe('claude account switch when the new account cannot resume the session', () => {
  const liveKey = agentReuseKey(CLAUDE_AGENT_CONFIG_ID, '/work', 'office')

  function failReopenWith(error: Error): void {
    retryCrashedSession.mockImplementation(async (id: string) => {
      useAcpStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          [id]: {
            ...s.sessions[id],
            agentId: 'agent-new',
            status: 'closed',
            lastError: `Resume failed: ${String(error)}`
          }
        }
      }))
      throw error
    })
  }

  beforeEach(() => {
    vi.spyOn(acpApi, 'newSession').mockResolvedValue({ sessionId: 's-new' } as never)
    vi.spyOn(acpApi, 'sendPrompt').mockResolvedValue('end_turn' as never)
    vi.spyOn(acpApi, 'sendPromptBlocks').mockResolvedValue('end_turn' as never)
    useAcpStore.setState({
      agentConfigs: [
        { id: CLAUDE_AGENT_CONFIG_ID, name: 'Claude Agent', command: 'claude', args: [], env: {} }
      ],
      configToLiveAgent: { [liveKey]: 'agent-new' },
      agents: { 'agent-new': { id: 'agent-new', capabilities: {} } as never },
      agentStatus: { 'agent-new': 'connected' },
      messages: {
        c1: [
          {
            id: 'm1',
            role: 'user',
            blocks: [{ type: 'text', text: 'fix the login bug' }],
            streaming: false,
            timestamp: 1,
            seq: 1
          },
          {
            id: 'm2',
            role: 'agent',
            blocks: [{ type: 'text', text: 'Fixed in auth.ts' }],
            streaming: false,
            timestamp: 2,
            seq: 2
          }
        ]
      } as never
    })
    openChatTabs(['c1'])
  })

  it('continues the chat in a new session that keeps the transcript and gets a summary', async () => {
    failReopenWith(new AcpTransportError('not_found', 'Resource not found: {"uri": "c1"}'))

    await restartClaudeSession('c1')

    const state = useAcpStore.getState()
    expect([...getAgentChatSessionIdsInAllTrees(useWorkspaceStore.getState())]).toEqual(['s-new'])
    expect(state.messages['s-new']?.map((m) => m.id)).toEqual([
      'switch-splice:c1:m1',
      'switch-splice:c1:m2'
    ])
    expect(acpApi.sendPrompt).toHaveBeenCalledTimes(1)
    const [agentId, sessionId, wire] = vi.mocked(acpApi.sendPrompt).mock.calls[0]
    expect([agentId, sessionId]).toEqual(['agent-new', 's-new'])
    expect(wire).toContain('fix the login bug')
    expect(wire).toContain('Fixed in auth.ts')
    expect(state.configToLiveAgent[liveKey]).toBe('agent-new')
  })

  it('sends the held prompt again in the new session when continuing after a limit', async () => {
    failReopenWith(new AcpTransportError('not_found', 'Resource not found: {"uri": "c1"}'))

    await restartClaudeSession('c1', { resend: true })

    expect(retryCrashedSession).toHaveBeenCalledWith('c1', { resend: true })
    const [, sessionId, wire, , display] = vi.mocked(acpApi.sendPromptBlocks).mock.calls[0]
    expect(sessionId).toBe('s-new')
    expect(wire.slice(1)).toEqual([{ type: 'text', text: 'fix the login bug' }])
    expect(display).toEqual([{ type: 'text', text: 'fix the login bug' }])
  })

  it('keeps the chat stopped when the reopen fails for another reason', async () => {
    failReopenWith(new AcpTransportError('timeout', 'session/load timed out after 30s'))

    await restartClaudeSession('c1')

    expect([...getAgentChatSessionIdsInAllTrees(useWorkspaceStore.getState())]).toEqual(['c1'])
    expect(acpApi.newSession).not.toHaveBeenCalled()
    expect(useAcpStore.getState().sessions.c1?.lastError).toBe(
      'Resume failed: AcpTransportError: session/load timed out after 30s'
    )
  })
})

describe('a switch the host refuses', () => {
  it('leaves the open chats and their agents untouched', async () => {
    const before = useAcpStore.getState().sessions
    api.setProjectAccount.mockRejectedValue(
      new AcpTransportError(
        'claude_account_signed_out',
        'The Claude account "Work" is not signed in. Sign in to it in Settings → Accounts, then choose it again.'
      )
    )
    await expect(switchProjectClaudeAccount('office', 'ab12')).rejects.toMatchObject({
      code: 'claude_account_signed_out'
    })
    expect(killAgent).not.toHaveBeenCalled()
    expect(retryCrashedSession).not.toHaveBeenCalled()
    expect(useAcpStore.getState().sessions).toBe(before)
    expect(useAcpStore.getState().sessions.c1.status).toBe('active')
  })

  it('restarts nothing when another client switched the project first', async () => {
    const before = useAcpStore.getState().sessions
    api.setProjectAccount.mockResolvedValue(false)
    await expect(
      switchProjectClaudeAccount('office', 'ab12', {
        continueSessionIds: ['c1'],
        expectedAccountId: 'default'
      })
    ).resolves.toBeNull()
    expect(api.setProjectAccount).toHaveBeenCalledWith('office', 'ab12', {
      expectedAccountId: 'default'
    })
    expect(killAgent).not.toHaveBeenCalled()
    expect(retryCrashedSession).not.toHaveBeenCalled()
    expect(useAcpStore.getState().sessions).toBe(before)
  })
})
