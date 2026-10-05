/**
 * Issue #837 renderer half: on web, reopening a history session reuses the
 * HOST's live agent that owns the session instead of spawning a duplicate.
 *
 * The suite runs with `isTauriContext() → false` and a fake ACP transport
 * (`listAgentDetails` serving `ownsSession`-carrying summaries) so the
 * `adoptHostOwnedAgent` path — and its absence on desktop — is observable
 * end-to-end through `openHistorySession`.
 */
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
  isTauriContext: vi.fn(() => false),
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
    // Keep the REAL full loader: in server-history mode it reads through the
    // fake transport's `getSessionPayload` (the "host-owned" durable record).
    loadSessionPayload: actual.loadSessionPayload,
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

vi.mock('@/stores/workspace-store', () => ({
  agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
  getAllLeafPanes: () => [],
  findPaneContainingTab: () => null,
  useWorkspaceStore: {
    getState: () => ({ addAgentChatTab: vi.fn(), root: null })
  }
}))

vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: vi.fn(),
  getTabFocusedSessionId: vi.fn(() => null)
}))

const { mockPersistenceApi } = vi.hoisted(() => ({
  mockPersistenceApi: {
    read: vi.fn(async () => ({ success: false })),
    write: vi.fn(),
    writeDebounced: vi.fn(async () => ({ success: true })),
    delete: vi.fn(async () => ({ success: true }))
  }
}))
vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    persistenceApi: mockPersistenceApi
  }
})

import type { AcpTransport } from '@/lib/acp-transport'
import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  AcpTransportError
} from '@/lib/acp-transport'
import { isTauriContext } from '@/lib/tauri-runtime'
import {
  _resetAcpAuthForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetHistorySeqWatermarksForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetInFlightPreparedForTesting,
  _resetLiveSwitchSourcesForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH } from './testkit'

/** Reuse-key separator (see `acp-reuse-keys.ts`). */
const NUL = '\0'

/**
 * Web-capable fake transport: only what `openHistorySession` touches in
 * server-history mode. `payloads` feeds `getSessionPayload` (the durable
 * records the "host" owns); `summaries` feeds `listAgentDetails`.
 */
function fakeWebTransport(
  summaries: Array<Record<string, unknown>>,
  payloads: Record<string, unknown> = {}
): AcpTransport & {
  loadSession: ReturnType<typeof vi.fn>
  subscribeSession: ReturnType<typeof vi.fn>
  seedSessionCursor: ReturnType<typeof vi.fn>
  spawnAgent: ReturnType<typeof vi.fn>
} {
  return {
    listAgentDetails: async () => summaries,
    spawnAgent: vi.fn(async () => {
      throw new Error('spawn must not happen when a host agent owns the session')
    }),
    loadSession: vi.fn(async () => ({})),
    resumeSession: vi.fn(async () => ({})),
    getSessionPayload: async (id: string) => payloads[id] ?? null,
    getSessionPayloadTail: async () => null,
    subscribeSession: vi.fn(async () => {}),
    seedSessionCursor: vi.fn(),
    connect: async () => {},
    dispose: () => {},
    historyMode: () => 'server' as const
  } as unknown as AcpTransport & {
    loadSession: ReturnType<typeof vi.fn>
    subscribeSession: ReturnType<typeof vi.fn>
    seedSessionCursor: ReturnType<typeof vi.fn>
    spawnAgent: ReturnType<typeof vi.fn>
  }
}

const HOST_AGENT = 'agent-host-original'

function seededPayload(id: string): Record<string, unknown> {
  const payload = {
    metadata: {
      id,
      agentId: HOST_AGENT,
      agentConfigId: 'acp-registry:claude-acp',
      title: 'Host-owned chat',
      cwd: '/w',
      projectId: 'p1',
      createdAt: 1,
      lastActivityAt: 2,
      messageCount: 1,
      status: 'active'
    },
    messages: [
      {
        id: 'm1',
        role: 'user',
        blocks: [{ type: 'text', text: 'hello' }],
        streaming: false,
        timestamp: 0,
        seq: 1
      }
    ]
  }
  return payload
}

describe('acp-store: host agent reuse on web (#837)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauriContext).mockReturnValue(false)
    _resetAcpTransportForTests(null)
    _resetInFlightHistoryOpensForTesting()
    _resetAcpAuthForTesting()
    _resetInFlightPreparedForTesting()
    _resetEphemeralSessionIdsForTesting()
    _resetSessionIndexLoadGenerationForTesting()
    _resetHistorySeqWatermarksForTesting()
    _resetLiveSwitchSourcesForTesting()
    useAcpStore.setState(FRESH)
    // The session's agent config must exist for ensureLiveAgent/adopt paths.
    useAcpStore.setState({
      agentConfigs: [
        {
          id: 'acp-registry:claude-acp',
          name: 'Claude',
          command: 'claude',
          args: [],
          env: {},
          templateId: 'claude-acp'
        }
      ]
    })
  })

  it('openHistorySession on web reuses the host agent that owns the session', async () => {
    const transport = fakeWebTransport(
      [
        {
          id: HOST_AGENT,
          name: 'Claude',
          configId: 'acp-registry:claude-acp',
          capabilities: { loadSession: true },
          ownsSession: ['s-host']
        }
      ],
      { 's-host': seededPayload('s-host') }
    )
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-host')

    const state = useAcpStore.getState()
    // The session record points at the HOST agent (not a fresh spawn).
    expect(state.sessions['s-host']?.agentId).toBe(HOST_AGENT)
    // The reuse key is registered so later prepareChat/prewarm reuse the host
    // process instead of spawning another one.
    expect(state.configToLiveAgent['acp-registry:claude-acp' + NUL + '/w']).toBe(HOST_AGENT)
    // Store presence is seeded from the summary: status connected + the
    // summary capabilities (drives decideResume + capability gates).
    expect(state.agentStatus[HOST_AGENT]).toBe('connected')
    expect(state.agents[HOST_AGENT]?.capabilities).toEqual({ loadSession: true })
    // 'load' strategy (loadSession capability) ran on the host agent — the
    // session is live again, and no spawn happened.
    expect(state.sessions['s-host']?.status).toBe('active')
  })

  it('falls back to spawning when no live agent owns the session', async () => {
    const transport = fakeWebTransport(
      [
        {
          id: 'agent-other',
          name: 'Other',
          capabilities: { loadSession: true },
          ownsSession: ['some-other-session']
        }
      ],
      { 's-unowned': seededPayload('s-unowned') }
    )
    _setAcpTransportForTests(transport)

    // spawnAgent throws in this fake; the store's silentSpawnFailure path
    // swallows it and leaves the local transcript readable ('local' strategy
    // needs no agent).
    await useAcpStore.getState().openHistorySession('s-unowned')
    const state = useAcpStore.getState()
    expect(state.configToLiveAgent['acp-registry:claude-acp' + NUL + '/w']).toBeUndefined()
    expect(state.agentStatus[HOST_AGENT]).toBeUndefined()
    expect(state.messages['s-unowned']).toHaveLength(1)
  })

  it('prefers the owner whose configId matches the session config', async () => {
    const transport = fakeWebTransport(
      [
        {
          id: 'agent-wrong-config',
          name: 'Wrong',
          configId: 'acp-registry:codex-acp',
          capabilities: {},
          ownsSession: ['s-two-owners']
        },
        {
          id: 'agent-right-config',
          name: 'Right',
          configId: 'acp-registry:claude-acp',
          capabilities: { loadSession: true },
          ownsSession: ['s-two-owners']
        }
      ],
      { 's-two-owners': seededPayload('s-two-owners') }
    )
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-two-owners')
    expect(useAcpStore.getState().sessions['s-two-owners']?.agentId).toBe('agent-right-config')
  })

  it('a listing failure degrades to the spawn path instead of throwing', async () => {
    const transport = fakeWebTransport([], { 's-listfail': seededPayload('s-listfail') })
    ;(transport as unknown as { listAgentDetails: () => Promise<unknown> }).listAgentDetails =
      async () => {
        throw new Error('ws down')
      }
    _setAcpTransportForTests(transport)

    await expect(useAcpStore.getState().openHistorySession('s-listfail')).resolves.toBeUndefined()
    expect(useAcpStore.getState().messages['s-listfail']).toHaveLength(1)
  })

  it('subscribes to a live turn instead of loading the session (#882)', async () => {
    const payload = seededPayload('s-live')
    payload.metadata = {
      ...(payload.metadata as Record<string, unknown>),
      turnActive: true,
      lastSeq: 75,
      status: 'active'
    }
    const transport = fakeWebTransport(
      [
        {
          id: HOST_AGENT,
          name: 'Claude',
          configId: 'acp-registry:claude-acp',
          capabilities: { loadSession: true },
          ownsSession: ['s-live']
        }
      ],
      { 's-live': payload }
    )
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-live')

    const session = useAcpStore.getState().sessions['s-live']
    expect(transport.loadSession).not.toHaveBeenCalled()
    expect(transport.subscribeSession).toHaveBeenCalledWith('s-live', 75, true)
    expect(transport.seedSessionCursor).toHaveBeenCalledWith('s-live', 75)
    expect(transport.spawnAgent).not.toHaveBeenCalled()
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(true)
    expect(session?.lastError).toBeNull()
    expect(session?.agentId).toBe(HOST_AGENT)
  })

  it('falls back to subscribe when load is rejected with ACP_REOPEN_TURN_ACTIVE (#882)', async () => {
    const payload = seededPayload('s-reopen')
    payload.metadata = {
      ...(payload.metadata as Record<string, unknown>),
      status: 'active',
      lastSeq: 75
    }
    payload.messages = [
      ...(payload.messages as unknown[]),
      {
        id: 'm2',
        role: 'agent',
        blocks: [{ type: 'text', text: 'ECHO-OK' }],
        streaming: true,
        timestamp: 1,
        seq: 2
      }
    ]
    const transport = fakeWebTransport(
      [
        {
          id: HOST_AGENT,
          name: 'Claude',
          configId: 'acp-registry:claude-acp',
          capabilities: { loadSession: true },
          ownsSession: ['s-reopen']
        }
      ],
      { 's-reopen': payload }
    )
    transport.loadSession.mockRejectedValue(
      new AcpTransportError('not_implemented', 'ACP_REOPEN_TURN_ACTIVE: session s-reopen')
    )
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-reopen')

    const session = useAcpStore.getState().sessions['s-reopen']
    expect(transport.loadSession).toHaveBeenCalled()
    expect(transport.subscribeSession).toHaveBeenCalledWith('s-reopen', 75, true)
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(true)
    expect(session?.openTurnId).toBe('turn:live')
    expect(session?.lastError).toBeNull()
    expect(session?.lastError ?? '').not.toContain('Resume failed')
  })

  it('still loads an idle status-active session (#882)', async () => {
    const payload = seededPayload('s-idle')
    payload.messages = [
      ...(payload.messages as unknown[]),
      {
        id: 'm2',
        role: 'agent',
        blocks: [{ type: 'text', text: 'done' }],
        streaming: false,
        timestamp: 1,
        seq: 2
      }
    ]
    const transport = fakeWebTransport(
      [
        {
          id: HOST_AGENT,
          name: 'Claude',
          configId: 'acp-registry:claude-acp',
          capabilities: { loadSession: true },
          ownsSession: ['s-idle']
        }
      ],
      { 's-idle': payload }
    )
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-idle')

    expect(transport.loadSession).toHaveBeenCalled()
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    expect(useAcpStore.getState().sessions['s-idle']?.status).toBe('active')
  })

  it('attaches on desktop without subscribeSession or a second spawn (#882)', async () => {
    vi.mocked(isTauriContext).mockReturnValue(true)
    const payload = seededPayload('s-desk')
    payload.metadata = {
      ...(payload.metadata as Record<string, unknown>),
      turnActive: true,
      lastSeq: 4
    }
    const transport = fakeWebTransport(
      [
        {
          id: HOST_AGENT,
          name: 'Claude',
          configId: 'acp-registry:claude-acp',
          capabilities: { loadSession: true },
          ownsSession: ['s-desk']
        }
      ],
      { 's-desk': payload }
    )
    delete (transport as { subscribeSession?: unknown }).subscribeSession
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-desk')

    const session = useAcpStore.getState().sessions['s-desk']
    expect(transport.spawnAgent).not.toHaveBeenCalled()
    expect(transport.loadSession).not.toHaveBeenCalled()
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(true)
    expect(session?.lastError).toBeNull()
    expect(session?.agentId).toBe(HOST_AGENT)
  })
})
