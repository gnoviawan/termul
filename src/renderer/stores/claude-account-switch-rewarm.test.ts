/**
 * A Project account switch with one open chat and one warm session: the
 * chat's reopen and the re-warm both want an agent for the same reuse key,
 * and each must get its own (one Agent process per Agent chat).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => false),
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/acp-agents-persistence', async (orig) => ({
  ...(await orig<typeof import('@/lib/acp-agents-persistence')>()),
  loadAgentConfigs: vi.fn(async () => []),
  saveAgentConfigs: vi.fn(async () => {})
}))
vi.mock('@/lib/acp-history-persistence', async (orig) => ({
  ...(await orig<typeof import('@/lib/acp-history-persistence')>()),
  loadSessionIndex: vi.fn(async () => []),
  saveSessionIndex: vi.fn(async () => {}),
  saveSessionPayload: vi.fn(async () => {}),
  queueSessionPayloadSave: vi.fn(async () => {}),
  queueSessionPayloadDelete: vi.fn(async () => {})
}))
vi.mock('@/lib/acp-mcp-persistence', async (orig) => ({
  ...(await orig<typeof import('@/lib/acp-mcp-persistence')>()),
  loadMcpServers: vi.fn(async () => []),
  saveMcpServers: vi.fn(async () => {}),
  syncMcpRegistryToProjectBestEffort: vi.fn(async () => {})
}))
vi.mock('@/stores/workspace-store', () => ({
  agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
  getAllLeafPanes: () => [],
  getAllTreeRoots: () => [],
  findPaneContainingTab: () => null,
  getAgentChatSessionIdsInAllTrees: () => new Set(openTabs),
  useWorkspaceStore: {
    getState: () => ({ addAgentChatTab: vi.fn(), root: { type: 'leaf', id: 'pane-1', tabs: [] } })
  }
}))
vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: vi.fn(),
  getTabFocusedSessionId: vi.fn(() => null)
}))
vi.mock('@/lib/api', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/api')>()),
  persistenceApi: {
    read: vi.fn(async () => ({ success: false })),
    write: vi.fn(),
    writeDebounced: vi.fn(async () => ({ success: true })),
    delete: vi.fn(async () => ({ success: true }))
  }
}))

const { host, openTabs } = vi.hoisted(() => ({
  openTabs: new Set<string>(['c1']),
  host: {
    projectAccount: 'personal',
    agentAccount: {} as Record<string, string>,
    killed: [] as string[],
    disposed: [] as string[],
    setProjectAccount: vi.fn()
  }
}))
vi.mock('@/lib/claude-accounts-api', () => ({
  claudeAccountsApi: { setProjectAccount: host.setProjectAccount }
}))

import type { ChatMessage } from '@/lib/acp-api'
import { _clearPayloadCacheForTesting, type SessionPayload } from '@/lib/acp-history-persistence'
import type { AcpTransport } from '@/lib/acp-transport'
import { _resetAcpTransportForTests, _setAcpTransportForTests } from '@/lib/acp-transport'
import {
  _resetAcpAuthForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetHistorySeqWatermarksForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetInFlightPreparedForTesting,
  _resetLiveSwitchSourcesForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  prepareChatKey,
  useAcpStore
} from '@/stores/acp-store'
import { _resetDefiniteSpawnRejectionsForTesting } from '@/stores/acp-store/shared-state'
import { FRESH } from '@/stores/acp-store/testkit'
import { useProjectStore } from '@/stores/project-store'
import { CLAUDE_AGENT_CONFIG_ID, switchProjectClaudeAccount } from './claude-account-switch'

const KEY = prepareChatKey(CLAUDE_AGENT_CONFIG_ID, '/work', undefined)
const CHAT = 'c1'
const OLD_AGENT = 'agent-old'

let agents = 0
let sessions = 0

const message = (
  id: string,
  role: ChatMessage['role'],
  text: string,
  seq: number
): ChatMessage => ({
  id,
  role,
  blocks: [{ type: 'text', text }],
  streaming: false,
  timestamp: 0,
  seq
})

const chatPayload: SessionPayload = {
  metadata: {
    id: CHAT,
    agentId: OLD_AGENT,
    agentConfigId: CLAUDE_AGENT_CONFIG_ID,
    title: 'Open chat',
    cwd: '/work',
    projectId: 'office',
    createdAt: 1,
    lastActivityAt: 2,
    messageCount: 1,
    lastSeq: 7,
    logEpoch: 'epoch-1',
    status: 'active'
  },
  messages: [message('user:seq-7', 'user', 'hello', 7)]
}

function fakeTransport() {
  return {
    listAgentDetails: async () => [],
    spawnAgent: vi.fn(async () => {
      const agentId = `agent-${++agents}`
      host.agentAccount[agentId] = host.projectAccount
      return { agentId, capabilities: { loadSession: true, sessionCapabilities: { resume: {} } } }
    }),
    killAgent: vi.fn(async (agentId: string) => {
      host.killed.push(agentId)
    }),
    newSession: vi.fn(async () => ({ sessionId: `sess-${++sessions}` })),
    disposeEphemeralSession: vi.fn(async (_agentId: string, sessionId: string) => {
      host.disposed.push(sessionId)
    }),
    promoteSession: vi.fn(async () => {}),
    loadSession: vi.fn(async () => ({})),
    resumeSession: vi.fn(async () => ({})),
    getSessionPayload: vi.fn(async () => chatPayload),
    getSessionPayloadTail: vi.fn(async () => chatPayload),
    subscribeSession: vi.fn(async () => {}),
    seedSessionCursor: vi.fn(),
    connect: async () => {},
    dispose: () => {},
    historyMode: () => 'server' as const
  }
}

const accountOf = (sessionId: string | null | undefined): string | undefined =>
  sessionId
    ? host.agentAccount[useAcpStore.getState().sessions[sessionId]?.agentId ?? '']
    : undefined

beforeEach(async () => {
  vi.clearAllMocks()
  agents = 0
  sessions = 0
  Object.assign(host, { projectAccount: 'personal', agentAccount: {}, killed: [], disposed: [] })
  host.agentAccount[OLD_AGENT] = 'personal'
  host.setProjectAccount.mockImplementation(async (_projectId: string, accountId: string) => {
    host.projectAccount = accountId
    return true
  })
  _resetAcpTransportForTests(null)
  _resetInFlightHistoryOpensForTesting()
  _resetAcpAuthForTesting()
  _resetInFlightPreparedForTesting()
  _resetEphemeralSessionIdsForTesting()
  _resetSessionIndexLoadGenerationForTesting()
  _resetHistorySeqWatermarksForTesting()
  _resetLiveSwitchSourcesForTesting()
  _resetDefiniteSpawnRejectionsForTesting()
  _clearPayloadCacheForTesting()
  useProjectStore.setState({ projects: [{ id: 'office', name: 'Office', path: '/work' } as never] })
  useAcpStore.setState({
    ...FRESH,
    agentConfigs: [
      {
        id: CLAUDE_AGENT_CONFIG_ID,
        name: 'Claude',
        command: 'claude',
        args: [],
        env: {},
        templateId: 'claude-acp'
      }
    ],
    agents: {
      [OLD_AGENT]: {
        id: OLD_AGENT,
        capabilities: { loadSession: true, sessionCapabilities: { resume: {} } }
      }
    } as never,
    agentStatus: { [OLD_AGENT]: 'connected' },
    configToLiveAgent: { [`${CLAUDE_AGENT_CONFIG_ID}\0/work\0office`]: OLD_AGENT },
    sessions: {
      [CHAT]: {
        id: CHAT,
        agentId: OLD_AGENT,
        cwd: '/work',
        projectId: 'office',
        status: 'active',
        title: 'Open chat',
        activeTurn: false,
        openTurnId: null,
        modes: null,
        models: null,
        configOptions: [],
        lastError: null,
        createdAt: 1
      }
    },
    sessionIndex: [
      {
        id: CHAT,
        agentId: OLD_AGENT,
        agentConfigId: CLAUDE_AGENT_CONFIG_ID,
        title: 'Open chat',
        cwd: '/work',
        projectId: 'office',
        createdAt: 1,
        lastActivityAt: 1,
        messageCount: 1,
        status: 'active'
      }
    ],
    messages: { [CHAT]: chatPayload.messages }
  } as never)
  _setAcpTransportForTests(fakeTransport() as unknown as AcpTransport)
})

async function warmSession(): Promise<string> {
  useAcpStore.getState().prepareChat(CLAUDE_AGENT_CONFIG_ID, '/work', undefined, 'office')
  await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[KEY]).toBeDefined())
  return useAcpStore.getState().preparedSessions[KEY] as string
}

describe('account switch with an open chat and a warm session', () => {
  it('restarts the chat and re-warms on the new account, each on its own agent', async () => {
    const warm = await warmSession()
    const warmAgent = useAcpStore.getState().sessions[warm]?.agentId as string
    expect(warmAgent).not.toBe(OLD_AGENT)
    expect(accountOf(warm)).toBe('personal')

    await switchProjectClaudeAccount('office', 'work')
    // The launcher re-prepares when its warm slot is gone (AgentLauncher.tsx:1211).
    useAcpStore.getState().prepareChat(CLAUDE_AGENT_CONFIG_ID, '/work', undefined, 'office', {
      silent: true
    })

    await vi.waitFor(() => {
      const next = useAcpStore.getState().preparedSessions[KEY] ?? null
      expect(next).not.toBe(warm)
      expect(accountOf(next)).toBe('work')
    })
    const state = useAcpStore.getState()
    const chat = state.sessions[CHAT]
    const next = state.preparedSessions[KEY] as string
    expect(chat?.status).toBe('active')
    expect(accountOf(CHAT)).toBe('work')
    // Both old-account processes are stopped.
    expect(host.killed).toEqual(expect.arrayContaining([OLD_AGENT, warmAgent]))
    // The old warm session goes with its agent: no dispose against a process being stopped.
    expect(host.disposed).not.toContain(warm)
    // One Agent process per Agent chat: the restarted chat must not sit on the
    // process whose warm session the launcher claims next.
    expect(chat?.agentId).not.toBe(state.sessions[next]?.agentId)
  })

  it('a second switch keeps the running turn of the chat launched after the first one', async () => {
    await warmSession()
    await switchProjectClaudeAccount('office', 'work')
    useAcpStore.getState().prepareChat(CLAUDE_AGENT_CONFIG_ID, '/work', undefined, 'office', {
      silent: true
    })
    await vi.waitFor(() =>
      expect(accountOf(useAcpStore.getState().preparedSessions[KEY] ?? null)).toBe('work')
    )
    // The launcher sends: the warm session becomes chat c2, and it is busy.
    const c2 = useAcpStore.getState().claimPreparedChat(KEY, 'office') as string
    expect(c2).toBeTruthy()
    openTabs.add(c2)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [c2]: { ...s.sessions[c2], activeTurn: true, openTurnId: 'turn-1' }
      }
    }))

    await switchProjectClaudeAccount('office', 'personal')
    await new Promise((resolve) => setTimeout(resolve, 50))

    const after = useAcpStore.getState().sessions[c2]
    // c2's turn is still running; its restart waits for the turn to end.
    expect(after?.status).toBe('active')
    expect(after?.activeTurn).toBe(true)
  })

  it('stops a warm agent whose session was prepared during the switch (no orphan process)', async () => {
    const transport = fakeTransport()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const realSpawn = transport.spawnAgent.getMockImplementation() as () => Promise<unknown>
    transport.spawnAgent.mockImplementationOnce(async () => {
      const result = await realSpawn()
      await held
      return result
    })
    _setAcpTransportForTests(transport as unknown as AcpTransport)
    useAcpStore.setState({
      sessions: {},
      sessionIndex: [],
      configToLiveAgent: {},
      agents: {},
      agentStatus: {}
    })

    useAcpStore.getState().prepareChat(CLAUDE_AGENT_CONFIG_ID, '/work', undefined, 'office')
    await vi.waitFor(() => expect(transport.spawnAgent).toHaveBeenCalledTimes(1))
    await switchProjectClaudeAccount('office', 'work')
    release()

    await vi.waitFor(() =>
      expect(accountOf(useAcpStore.getState().preparedSessions[KEY] ?? null)).toBe('work')
    )
    // agent-1 was spawned on the old account and serves nothing now.
    expect(host.killed).toContain('agent-1')
  })
})
