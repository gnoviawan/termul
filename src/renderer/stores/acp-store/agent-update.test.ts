import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toastError, toastWarning } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastWarning: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: toastError, warning: toastWarning }
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))
vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))
vi.mock('@/lib/acp-agents-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-agents-persistence')>()
  return {
    ...actual,
    loadAgentConfigs: vi.fn(async () => []),
    saveAgentConfigs: vi.fn(async () => {})
  }
})
vi.mock('@/lib/acp-history-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-history-persistence')>()
  return {
    ...actual,
    loadSessionIndex: vi.fn(async () => []),
    saveSessionIndex: vi.fn(async () => {}),
    saveSessionPayload: vi.fn(async () => {}),
    queueSessionPayloadSave: vi.fn(async () => {}),
    queueSessionPayloadDelete: vi.fn(async () => {}),
    // Read-through the module-level cache so tests can seed payloads via
    // setCachedSessionPayload (preferred over per-test mockResolvedValue).
    loadSessionPayload: vi.fn(async (id: string) => actual.getCachedSessionPayload(id) ?? null),
    // Tail-first: the store calls `loadSessionPayloadTail` first, then falls
    // back to `loadSessionPayload`. Mock both to the same cache-backed fn so
    // per-test `mockResolvedValueOnce` on `loadSessionPayload` still fires
    // (the tail mock returns null when no cache is seeded → fallback runs).
    // The CAP-7 chain walk uses the (cache-backed) full loader for hop
    // resolution — the tail mock's null never blocks it.
    loadSessionPayloadTail: vi.fn(async () => null)
  }
})
vi.mock('@/lib/acp-mcp-persistence', async (orig) => {
  const actual = await orig<typeof import('@/lib/acp-mcp-persistence')>()
  return {
    ...actual,
    loadMcpServers: vi.fn(async () => []),
    saveMcpServers: vi.fn(async () => {}),
    syncMcpRegistryToProjectBestEffort: vi.fn(async () => {})
  }
})

// Spies for the switch-back reopen branch (addAgentChatTab +
// setTabFocusedSessionId). `getTabFocusedSessionId` returns null so
// switchProject falls back to `activeSessionId` (matching the real behavior
// when no tab focus is set). `workspaceStateRef` is the fake surface for the
// corpse-tab prune (loadSessionIndex) + failed-launch tab remap
// (retryFailedLaunch): seed `.root` with pane trees and observe the spies.
const { addAgentChatTabSpy, setTabFocusedSessionIdSpy, workspaceStateRef } = vi.hoisted(() => ({
  addAgentChatTabSpy: vi.fn(),
  setTabFocusedSessionIdSpy: vi.fn(),
  workspaceStateRef: {
    current: {
      root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
      removeTab: vi.fn(),
      remapAgentChatSession: vi.fn()
    }
  }
}))

vi.mock('@/stores/workspace-store', () => {
  // Local mirrors of the real pane helpers (importing the real module would
  // drag terminal-store/router side effects into this suite).
  type PaneNodeLike = {
    type: string
    tabs?: Array<{ type: string; id: string; sessionId?: string }>
    children?: PaneNodeLike[]
  }
  const getAllLeafPanes = (root: PaneNodeLike): PaneNodeLike[] =>
    root.type === 'leaf' ? [root] : (root.children ?? []).flatMap(getAllLeafPanes)
  const findPaneContainingTab = (root: PaneNodeLike, tabId: string): PaneNodeLike | null => {
    for (const leaf of getAllLeafPanes(root)) {
      if ((leaf.tabs ?? []).some((t) => t.id === tabId)) return leaf
    }
    return null
  }
  return {
    getAllLeafPanes,
    findPaneContainingTab,
    agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
    useWorkspaceStore: {
      getState: () => ({
        addAgentChatTab: addAgentChatTabSpy,
        removeTab: workspaceStateRef.current.removeTab,
        remapAgentChatSession: workspaceStateRef.current.remapAgentChatSession,
        root: workspaceStateRef.current.root
      })
    }
  }
})

vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: setTabFocusedSessionIdSpy,
  getTabFocusedSessionId: vi.fn(() => null)
}))

// Mock persistenceApi so composer-selection persistence calls are observable
// in tests without hitting the Tauri plugin-store transport. Preserve other
// `@/lib/api` exports via importActual so transitive imports still resolve.
const { mockPersistenceApi, mockListCatalog } = vi.hoisted(() => ({
  mockPersistenceApi: {
    // Defaults reproduce the implementation leak the single-file suite relied
    // on; tests override per-test via mockResolvedValue(Once) as before.
    read: vi.fn(async () => ({ success: false })),
    write: vi.fn(),
    writeDebounced: vi.fn(async () => ({ success: true })),
    // Story 3 (spec-in-chat-agent-switch): the switch clears the old
    // session's composer draft via persistenceApi.delete.
    delete: vi.fn(async () => ({ success: true }))
  },
  mockListCatalog: vi.fn()
}))
vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    persistenceApi: mockPersistenceApi,
    acpCatalogApi: { ...actual.acpCatalogApi, listCatalog: mockListCatalog }
  }
})

import { invoke } from '@tauri-apps/api/core'
import type { RegistryAgent } from '@/lib/agents/acp-registry'
import { type AcpSession, agentReuseKey, useAcpStore } from '@/stores/acp-store'

describe('applyAgentUpdate', () => {
  beforeEach(() => {
    mockListCatalog.mockResolvedValue({
      success: true,
      data: { host: { os: 'macos', arch: 'aarch64', runtimes: {} }, agents: [] }
    })
  })
  it('dedupes concurrent applies for the same config into one host install', async () => {
    // Binary agent (needs-install): two rapid "Update" clicks — launcher and
    // Settings, or an impatient double-click — must not download the archive
    // twice. The second call joins the in-flight apply.
    useAcpStore.setState({
      agentConfigs: [
        {
          id: 'acp-registry:cursor',
          templateId: 'cursor',
          configId: 'acp-registry:cursor',
          name: 'Cursor',
          command: '/opt/cursor-agent',
          args: ['acp'],
          env: {},
          allowTerminal: false
        }
      ]
    })
    let resolveInstall!: (value: {
      success: boolean
      data?: { command: string; args: string[] }
      error?: string
      code?: string
    }) => void
    vi.mocked(invoke).mockImplementation((_cmd, args) => {
      const agentId = (args as { request: { agentId: string } }).request.agentId
      if (agentId === 'cursor') {
        return new Promise((resolve) => {
          resolveInstall = resolve
        })
      }
      return Promise.resolve({ success: false, error: 'unexpected invoke', code: 'UNEXPECTED' })
    })
    const agent = {
      id: 'cursor',
      name: 'Cursor',
      version: '2026.09.10',
      description: 'Cursor',
      distribution: {
        binary: {
          'darwin-aarch64': {
            archive: 'https://downloads.cursor.com/agent.zip',
            cmd: 'cursor-agent'
          }
        }
      }
    } as RegistryAgent

    const first = useAcpStore.getState().applyAgentUpdate('acp-registry:cursor', agent)
    const second = useAcpStore.getState().applyAgentUpdate('acp-registry:cursor', agent)
    // Flush the catalog await so the install actually starts before resolving.
    await vi.waitFor(() => {
      const installCalls = vi
        .mocked(invoke)
        .mock.calls.filter(([cmd]) => cmd === 'acp_install_agent')
      expect(installCalls).toHaveLength(1)
    })
    resolveInstall({ success: true, data: { command: '/opt/cursor-agent-2', args: ['acp'] } })
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe('applied')
    expect(b).toBe('applied')
    const installCalls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'acp_install_agent')
    expect(installCalls).toHaveLength(1)
  })

  it('kills idle warm processes on apply so the next chat spawns the applied version', async () => {
    vi.mocked(invoke).mockClear()
    useAcpStore.setState({
      agentConfigs: [
        {
          id: 'acp-registry:cursor',
          templateId: 'cursor',
          configId: 'acp-registry:cursor',
          name: 'Cursor',
          command: '/opt/cursor-agent',
          args: ['acp'],
          env: {},
          allowTerminal: false
        }
      ],
      // Idle warm process: reuse-mapped, no open session references it.
      configToLiveAgent: { 'acp-registry:cursor\0/work': 'warm-1' },
      sessions: {}
    })
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === 'acp_install_agent') {
        return Promise.resolve({ success: true, data: { command: '/opt/cursor-2', args: ['acp'] } })
      }
      return Promise.resolve(undefined)
    })
    await useAcpStore.getState().applyAgentUpdate('acp-registry:cursor', {
      id: 'cursor',
      name: 'Cursor',
      version: '2026.09.18',
      description: 'Cursor',
      distribution: {
        binary: {
          'darwin-aarch64': {
            archive: 'https://downloads.cursor.com/agent.zip',
            cmd: 'cursor-agent'
          }
        }
      }
    } as RegistryAgent)
    expect(useAcpStore.getState().configToLiveAgent['acp-registry:cursor\0/work']).toBeUndefined()
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'acp_kill_agent')).toBe(true)
  })

  it('detaches but preserves a warm process that still has an open chat', async () => {
    vi.mocked(invoke).mockClear()
    useAcpStore.setState({
      agentConfigs: [
        {
          id: 'acp-registry:cursor',
          templateId: 'cursor',
          configId: 'acp-registry:cursor',
          name: 'Cursor',
          command: '/opt/cursor-agent',
          args: ['acp'],
          env: {},
          allowTerminal: false
        }
      ],
      configToLiveAgent: { 'acp-registry:cursor\0/work': 'warm-1' },
      sessions: {
        s1: {
          id: 's1',
          agentId: 'warm-1',
          cwd: '/work',
          projectId: 'p1',
          status: 'connected',
          title: null,
          activeTurn: false,
          openTurnId: null,
          modes: null,
          configOptions: [],
          lastError: null,
          createdAt: 0
        } as AcpSession
      }
    })
    vi.mocked(invoke).mockImplementation((cmd) => {
      if (cmd === 'acp_install_agent') {
        return Promise.resolve({ success: true, data: { command: '/opt/cursor-2', args: ['acp'] } })
      }
      return Promise.resolve(undefined)
    })
    await useAcpStore.getState().applyAgentUpdate('acp-registry:cursor', {
      id: 'cursor',
      name: 'Cursor',
      version: '2026.09.18',
      description: 'Cursor',
      distribution: {
        binary: {
          'darwin-aarch64': {
            archive: 'https://downloads.cursor.com/agent.zip',
            cmd: 'cursor-agent'
          }
        }
      }
    } as RegistryAgent)
    // The reuse mapping detaches (future chats spawn fresh)…
    expect(useAcpStore.getState().configToLiveAgent['acp-registry:cursor\0/work']).toBeUndefined()
    // …but the live process is never killed while its chat is open.
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'acp_kill_agent')).toBe(false)
    expect(useAcpStore.getState().sessions.s1).toBeDefined()
  })

  it('rewrites the pinned launch args to the applied registry version and keeps the config identity', async () => {
    useAcpStore.setState({
      agentConfigs: [
        {
          id: 'acp-registry:factory-droid',
          templateId: 'factory-droid',
          configId: 'acp-registry:factory-droid',
          name: 'Factory Droid',
          command: 'npx',
          args: ['-y', 'droid@0.218.1', 'exec', '--output-format', 'acp'],
          env: { DROID_DISABLE_AUTO_UPDATE: 'true' },
          allowTerminal: false
        }
      ]
    })

    const outcome = await useAcpStore.getState().applyAgentUpdate('acp-registry:factory-droid', {
      id: 'factory-droid',
      name: 'Factory Droid',
      version: '0.219.0',
      description: 'Factory Droid - AI coding agent powered by Factory AI',
      distribution: {
        npx: { package: 'droid@0.219.0', args: ['exec', '--output-format', 'acp'] }
      }
    })

    expect(outcome).toBe('applied')
    const updated = useAcpStore
      .getState()
      .agentConfigs.find((c) => c.id === 'acp-registry:factory-droid')
    expect(updated?.args).toEqual(['-y', 'droid@0.219.0', 'exec', '--output-format', 'acp'])
    expect(updated?.command).toBe('npx')
    expect(updated?.templateId).toBe('factory-droid')
  })

  it('updates Claude ACP through the host package installer instead of restoring npx launch', async () => {
    useAcpStore.setState({
      agentConfigs: [
        {
          id: 'acp-registry:claude-acp',
          templateId: 'claude-acp',
          configId: 'acp-registry:claude-acp',
          name: 'Claude Agent',
          command: 'node',
          args: ['/termul/cache/old/dist/index.js'],
          env: {},
          allowTerminal: false
        }
      ]
    })
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'acp_install_agent') {
        return Promise.resolve({
          success: true,
          data: {
            command: 'node',
            args: ['/termul/cache/new/dist/index.js']
          }
        })
      }
      return Promise.resolve(undefined)
    })

    await useAcpStore.getState().applyAgentUpdate('acp-registry:claude-acp', {
      id: 'claude-acp',
      name: 'Claude Agent',
      version: '0.79.0',
      description: 'Claude ACP',
      distribution: {
        npx: { package: '@agentclientprotocol/claude-agent-acp@0.79.0' }
      }
    })

    const updated = useAcpStore
      .getState()
      .agentConfigs.find((config) => config.id === 'acp-registry:claude-acp')
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'acp_install_agent')).toBe(
      true
    )
    expect(updated?.command).toBe('node')
    expect(updated?.args).toEqual(['/termul/cache/new/dist/index.js'])
  })

  it('preserves user-added env values on conflict and fills registry env keys the config lacks', async () => {
    useAcpStore.setState({
      agentConfigs: [
        {
          id: 'acp-registry:factory-droid',
          templateId: 'factory-droid',
          configId: 'acp-registry:factory-droid',
          name: 'Factory Droid',
          command: 'npx',
          args: ['-y', 'droid@0.218.1', 'exec', '--output-format', 'acp'],
          env: { DROID_DISABLE_AUTO_UPDATE: 'true', MY_FLAG: 'user-value' },
          allowTerminal: false
        }
      ]
    })

    // The applied registry CHANGES DROID_DISABLE_AUTO_UPDATE to 'false' and
    // adds a new key — persisted values must win on conflict.
    const outcome = await useAcpStore.getState().applyAgentUpdate('acp-registry:factory-droid', {
      id: 'factory-droid',
      name: 'Factory Droid',
      version: '0.219.0',
      description: 'Factory Droid - AI coding agent powered by Factory AI',
      distribution: {
        npx: {
          package: 'droid@0.219.0',
          args: ['exec', '--output-format', 'acp'],
          env: { DROID_DISABLE_AUTO_UPDATE: 'false', FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false' }
        }
      }
    })

    expect(outcome).toBe('applied')
    const updated = useAcpStore
      .getState()
      .agentConfigs.find((c) => c.id === 'acp-registry:factory-droid')
    expect(updated?.env).toEqual({
      DROID_DISABLE_AUTO_UPDATE: 'true',
      MY_FLAG: 'user-value',
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false'
    })
  })

  it('reports unchanged when no persisted config exists for the config id', async () => {
    useAcpStore.setState({ agentConfigs: [] })

    const outcome = await useAcpStore.getState().applyAgentUpdate('acp-registry:factory-droid', {
      id: 'factory-droid',
      name: 'Factory Droid',
      version: '0.219.0',
      description: 'Factory Droid - AI coding agent powered by Factory AI',
      distribution: { npx: { package: 'droid@0.219.0', args: ['exec', '--output-format', 'acp'] } }
    })

    expect(outcome).toBe('unchanged')
    expect(useAcpStore.getState().agentConfigs).toEqual([])
  })

  it('throws when the registry agent has no runnable distribution for the platform', async () => {
    useAcpStore.setState({
      agentConfigs: [
        {
          id: 'acp-registry:someagent',
          templateId: 'someagent',
          configId: 'acp-registry:someagent',
          name: 'Some Agent',
          command: './someagent',
          args: ['acp'],
          env: {},
          allowTerminal: false
        }
      ]
    })

    await expect(
      useAcpStore.getState().applyAgentUpdate('acp-registry:someagent', {
        id: 'someagent',
        name: 'Some Agent',
        version: '1.1.0',
        description: '',
        distribution: { binary: { 'windows-x86_64': { cmd: './someagent.exe', args: ['acp'] } } }
      })
    ).rejects.toThrow('no runnable distribution')

    // The failed apply must not mutate the persisted config.
    const updated = useAcpStore
      .getState()
      .agentConfigs.find((c) => c.id === 'acp-registry:someagent')
    expect(updated?.args).toEqual(['acp'])
  })

  it('re-installs a host binary agent and overwrites the persisted config from the install outcome', async () => {
    useAcpStore.setState({
      agentConfigs: [
        {
          id: 'acp-registry:someagent',
          templateId: 'someagent',
          configId: 'acp-registry:someagent',
          name: 'Some Agent',
          command: '/abs/acp-registry-binaries/someagent/0.9.5/someagent',
          args: ['acp'],
          env: { MY_FLAG: 'user-value' },
          allowTerminal: false
        }
      ]
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_install_agent') {
        return {
          success: true,
          data: { command: '/abs/acp-registry-binaries/someagent/1.1.0/someagent', args: ['acp'] }
        }
      }
      throw new Error(`unexpected invoke: ${command}`)
    })

    const outcome = await useAcpStore.getState().applyAgentUpdate('acp-registry:someagent', {
      id: 'someagent',
      name: 'Some Agent',
      version: '1.1.0',
      description: '',
      distribution: {
        binary: {
          'darwin-aarch64': {
            cmd: './someagent',
            archive: 'https://example.com/someagent-darwin-arm64.zip',
            args: ['acp']
          }
        }
      }
    })

    expect(outcome).toBe('applied')
    const updated = useAcpStore
      .getState()
      .agentConfigs.find((c) => c.id === 'acp-registry:someagent')
    expect(updated?.command).toBe('/abs/acp-registry-binaries/someagent/1.1.0/someagent')
    expect(updated?.args).toEqual(['acp'])
    // User-added env survives the re-install overwrite.
    expect(updated?.env).toEqual({ MY_FLAG: 'user-value' })
  })

  it('records a pending restart version on apply and clears it when a chat is created', async () => {
    const configId = 'acp-registry:factory-droid'
    useAcpStore.setState({
      agentConfigs: [
        {
          id: configId,
          templateId: 'factory-droid',
          configId,
          name: 'Factory Droid',
          command: 'npx',
          args: ['-y', 'droid@0.218.1', 'exec', '--output-format', 'acp'],
          env: {},
          allowTerminal: false
        }
      ]
    })

    await useAcpStore.getState().applyAgentUpdate(configId, {
      id: 'factory-droid',
      name: 'Factory Droid',
      version: '0.219.0',
      description: '',
      distribution: { npx: { package: 'droid@0.219.0', args: ['exec', '--output-format', 'acp'] } }
    })
    expect(useAcpStore.getState().pendingRestartVersions[configId]).toBe('0.219.0')

    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent') {
        return { agentId: 'agent-new', capabilities: {}, authMethods: [] }
      }
      throw new Error(`unexpected invoke: ${command}`)
    })
    await useAcpStore.getState().spawnAgent({
      configId,
      name: 'Factory Droid',
      command: 'npx',
      args: ['-y', 'droid@0.219.0', 'exec', '--output-format', 'acp'],
      env: {},
      allowTerminal: false
    })
    // Spawn alone must not hide Restart — session creation can still fail.
    expect(useAcpStore.getState().pendingRestartVersions[configId]).toBe('0.219.0')

    useAcpStore.setState({
      configToLiveAgent: { [agentReuseKey(configId, '/work')]: 'agent-new' }
    })
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_new_session') {
        throw new Error('session failed')
      }
      throw new Error(`unexpected invoke: ${command}`)
    })
    await expect(
      useAcpStore.getState().createSession('agent-new', '/work', undefined, 'p1')
    ).rejects.toThrow('session failed')
    expect(useAcpStore.getState().pendingRestartVersions[configId]).toBe('0.219.0')

    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_new_session') {
        return { sessionId: 'sess-warm' }
      }
      throw new Error(`unexpected invoke: ${command}`)
    })
    await useAcpStore.getState().createSession('agent-new', '/work', undefined, 'p1', {
      ephemeral: true
    })
    expect(useAcpStore.getState().pendingRestartVersions[configId]).toBe('0.219.0')

    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'acp_new_session') {
        return { sessionId: 'sess-new' }
      }
      throw new Error(`unexpected invoke: ${command}`)
    })
    await useAcpStore.getState().createSession('agent-new', '/work', undefined, 'p1')
    expect(useAcpStore.getState().pendingRestartVersions[configId]).toBeUndefined()
  })
})
