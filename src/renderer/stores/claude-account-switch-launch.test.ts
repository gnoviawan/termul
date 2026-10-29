import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
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
  queueSessionPayloadDelete: vi.fn(async () => {}),
  loadSessionPayloadTail: vi.fn(async () => null)
}))
vi.mock('@/lib/acp-mcp-persistence', async (orig) => ({
  ...(await orig<typeof import('@/lib/acp-mcp-persistence')>()),
  loadMcpServers: vi.fn(async () => []),
  saveMcpServers: vi.fn(async () => {}),
  syncMcpRegistryToProjectBestEffort: vi.fn(async () => {})
}))
vi.mock('@/stores/workspace-store', () => ({
  getAllLeafPanes: () => [],
  getAllTreeRoots: () => [],
  findPaneContainingTab: () => null,
  agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
  getAgentChatSessionIdsInAllTrees: () => new Set<string>(),
  useWorkspaceStore: { getState: () => ({ root: { type: 'leaf', id: 'pane-1', tabs: [] } }) }
}))

const { host } = vi.hoisted(() => ({
  host: {
    /** The account the host gives the next spawn of project `office` (it reads it at spawn). */
    projectAccount: 'personal',
    agentAccount: {} as Record<string, string>,
    sessionAgent: {} as Record<string, string>,
    holdSpawns: false,
    held: [] as Array<() => void>,
    setProjectAccount: vi.fn()
  }
}))
vi.mock('@/lib/claude-accounts-api', () => ({
  claudeAccountsApi: { setProjectAccount: host.setProjectAccount }
}))

import { invoke } from '@tauri-apps/api/core'
import { prepareChatKey, useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { CLAUDE_AGENT_CONFIG_ID, switchProjectClaudeAccount } from './claude-account-switch'

const KEY = prepareChatKey(CLAUDE_AGENT_CONFIG_ID, '/work', undefined)

let agents = 0
let sessions = 0

function fakeHost(): void {
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    const a = (args ?? {}) as { agentId?: string }
    if (command === 'acp_spawn_agent') {
      const agentId = `agent-${++agents}`
      host.agentAccount[agentId] = host.projectAccount
      if (host.holdSpawns) await new Promise<void>((resolve) => host.held.push(resolve))
      return { agentId, capabilities: {}, authMethods: [] }
    }
    if (command === 'acp_new_session') {
      const sessionId = `sess-${++sessions}`
      host.sessionAgent[sessionId] = a.agentId ?? ''
      return { sessionId }
    }
    return undefined
  })
}

const accountOf = (sessionId: string | null): string | undefined =>
  sessionId ? host.agentAccount[host.sessionAgent[sessionId] ?? ''] : undefined

/** The launcher's send: claim the warm session, else start a chat. */
async function launchFirstChat(): Promise<string> {
  const claimed = useAcpStore.getState().claimPreparedChat(KEY, 'office')
  return (
    claimed ??
    (await useAcpStore.getState().startChat(CLAUDE_AGENT_CONFIG_ID, '/work', undefined, 'office'))
  )
}

async function warmSession(): Promise<string> {
  useAcpStore.getState().prepareChat(CLAUDE_AGENT_CONFIG_ID, '/work', undefined, 'office')
  await vi.waitFor(() => expect(useAcpStore.getState().preparedSessions[KEY]).toBeDefined())
  return useAcpStore.getState().preparedSessions[KEY] as string
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(invoke).mockReset()
  agents = 0
  sessions = 0
  Object.assign(host, {
    projectAccount: 'personal',
    agentAccount: {},
    sessionAgent: {},
    holdSpawns: false,
    held: []
  })
  host.setProjectAccount.mockImplementation(async (_projectId: string, accountId: string) => {
    host.projectAccount = accountId
    return true
  })
  useProjectStore.setState({ projects: [{ id: 'office', name: 'Office', path: '/work' } as never] })
  useAcpStore.setState({
    agents: {},
    agentStatus: {},
    agentConfigs: [],
    configToLiveAgent: {},
    warmingConfigs: {},
    preparedSessions: {},
    preparingChatKeys: {},
    prepareChatErrors: {},
    selectedAgentConfigId: CLAUDE_AGENT_CONFIG_ID,
    sessionIndex: [],
    sessions: {},
    activeSessionId: null,
    messages: {}
  })
  await useAcpStore.getState().saveAgentConfig({
    id: CLAUDE_AGENT_CONFIG_ID,
    name: 'Claude Agent',
    command: 'node',
    args: ['/state/claude-agent-acp/dist/index.js'],
    env: {}
  })
  fakeHost()
})

describe('first launcher chat after a Claude account pick', () => {
  it('runs on the new account when the user sends while the host write is in flight', async () => {
    const warm = await warmSession()
    expect(accountOf(warm)).toBe('personal')
    let finishWrite!: () => void
    host.setProjectAccount.mockImplementation(async (_projectId: string, accountId: string) => {
      host.projectAccount = accountId
      await new Promise<void>((resolve) => {
        finishWrite = resolve
      })
    })

    const switching = switchProjectClaudeAccount('office', 'work')
    const first = await launchFirstChat()
    finishWrite()
    await switching

    expect(first).not.toBe(warm)
    expect(accountOf(first)).toBe('work')
  })

  it('does not keep a warm session that was still preparing when the user picked', async () => {
    host.holdSpawns = true
    useAcpStore.getState().prepareChat(CLAUDE_AGENT_CONFIG_ID, '/work', undefined, 'office')
    await vi.waitFor(() => expect(host.held).toHaveLength(1))

    host.holdSpawns = false
    await switchProjectClaudeAccount('office', 'work')
    for (const release of host.held) release()

    await vi.waitFor(() =>
      expect(accountOf(useAcpStore.getState().preparedSessions[KEY] ?? null)).toBe('work')
    )
    expect(accountOf(await launchFirstChat())).toBe('work')
  })

  it('does not reuse an idle agent the project had before the pick', async () => {
    await useAcpStore.getState().prewarmAgent(CLAUDE_AGENT_CONFIG_ID, '/work')
    expect(host.agentAccount['agent-1']).toBe('personal')

    await switchProjectClaudeAccount('office', 'work')

    expect(accountOf(await launchFirstChat())).toBe('work')
  })

  it("prepares the launcher's warm session again on the new account", async () => {
    const warm = await warmSession()

    await switchProjectClaudeAccount('office', 'work')

    await vi.waitFor(() => {
      const next = useAcpStore.getState().preparedSessions[KEY] ?? null
      expect(next).not.toBe(warm)
      expect(accountOf(next)).toBe('work')
    })
    const first = await launchFirstChat()
    expect(accountOf(first)).toBe('work')
    expect(useAcpStore.getState().sessions[warm]?.status).not.toBe('active')
  })
})
