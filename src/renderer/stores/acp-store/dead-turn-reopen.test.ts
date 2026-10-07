/**
 * spec-acp-dead-turn-recovery (slice: reopen-liveness).
 *
 * Reopening a chat whose persisted transcript ends on a user bubble must
 * attach to the turn ONLY when it can still be live — authoritative
 * `turnActive`, or `status:'active'` + trailing user bubble — AND a
 * connected OWNING agent exists (a host-registered owner from
 * `adoptHostOwnedAgent`, or the persisted `meta.agentId` still connected
 * in-store). Every other shape is a DEAD turn: the optimistic
 * `activeTurn`/`openTurnId` install is cleared, `ensureLiveAgent` keeps the
 * chat usable, and the normal load/resume path runs instead of subscribing
 * to a `prompt_complete` that can never arrive. The
 * `ACP_REOPEN_TURN_ACTIVE` catches stay unconditional — that rejection is
 * in-band proof of liveness.
 *
 * The suite runs with `isTauriContext() → false` plus a fake web transport
 * (same harness as host-agent-reuse.test.ts) so `adoptHostOwnedAgent`,
 * `ensureLiveAgent`, and `attachLiveTurn` (`subscribeSession`) are all
 * observable end-to-end through `openHistorySession`/`resumeLiveSession`.
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
import { logFrontendError } from '@/lib/log-api'
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
import { FRESH, flushTurnEnd } from './testkit'

const CONFIG_ID = 'acp-registry:claude-acp'
const PERSISTED_AGENT = 'agent-persisted'
const FRESH_AGENT = 'agent-fresh'

type FakeTransport = AcpTransport & {
  loadSession: ReturnType<typeof vi.fn>
  resumeSession: ReturnType<typeof vi.fn>
  sendPrompt: ReturnType<typeof vi.fn>
  sendPromptBlocks: ReturnType<typeof vi.fn>
  subscribeSession: ReturnType<typeof vi.fn>
  seedSessionCursor: ReturnType<typeof vi.fn>
  spawnAgent: ReturnType<typeof vi.fn>
}

/**
 * Web-capable fake transport (same shape as host-agent-reuse.test.ts):
 * `summaries` feeds `listAgentDetails` (host-registered owners),
 * `payloads` feeds `getSessionPayload` (the durable record the host owns).
 * `spawnAgent` resolves a fresh connected agent with loadSession capability
 * so the degraded reopen lands a usable chat; tests override per-case.
 */
function fakeWebTransport(
  summaries: Array<Record<string, unknown>>,
  payloads: Record<string, unknown> = {}
): FakeTransport {
  return {
    listAgentDetails: async () => summaries,
    spawnAgent: vi.fn(async () => ({
      agentId: FRESH_AGENT,
      capabilities: { loadSession: true }
    })),
    loadSession: vi.fn(async () => ({})),
    resumeSession: vi.fn(async () => ({})),
    sendPrompt: vi.fn(async () => 'end_turn'),
    sendPromptBlocks: vi.fn(async () => 'end_turn'),
    getSessionPayload: async (id: string) => payloads[id] ?? null,
    getSessionPayloadTail: async () => null,
    subscribeSession: vi.fn(async () => {}),
    seedSessionCursor: vi.fn(),
    connect: async () => {},
    dispose: () => {},
    historyMode: () => 'server' as const
  } as unknown as FakeTransport
}

/** Payload that ends on an unmatched user bubble (the dead-turn shape). */
function trailingUserPayload(
  id: string,
  meta: Partial<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    metadata: {
      id,
      agentId: PERSISTED_AGENT,
      agentConfigId: CONFIG_ID,
      title: 'Chat',
      cwd: '/w',
      projectId: 'p1',
      createdAt: 1,
      lastActivityAt: 2,
      messageCount: 1,
      lastSeq: 10,
      status: 'active',
      ...meta
    },
    messages: [
      {
        id: 'm1',
        role: 'user',
        blocks: [{ type: 'text', text: 'still working?' }],
        streaming: false,
        timestamp: 0,
        seq: 1
      }
    ]
  }
}

function ownerSummary(sessionId: string, agentId = 'agent-owner'): Record<string, unknown> {
  return {
    id: agentId,
    name: 'Claude',
    configId: CONFIG_ID,
    capabilities: { loadSession: true },
    ownsSession: [sessionId]
  }
}

describe('acp-store: dead-turn reopen detach (reopen-liveness)', () => {
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
          id: CONFIG_ID,
          name: 'Claude',
          command: 'claude',
          args: [],
          env: {},
          templateId: 'claude-acp'
        }
      ]
    })
  })

  it('crashed chat reopened (status:error + trailing user) never attaches; a fresh agent resumes it and the composer sends', async () => {
    const transport = fakeWebTransport([], {
      's-crashed': trailingUserPayload('s-crashed', { status: 'error' })
    })
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-crashed')

    const session = useAcpStore.getState().sessions['s-crashed']
    // No attach: subscribing to the dead turn would wait on a
    // prompt_complete the crashed agent can never send.
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    // Degraded to ensureLiveAgent + decideResume: a fresh agent hosted a
    // normal session/load so the chat is usable again.
    expect(transport.spawnAgent).toHaveBeenCalledTimes(1)
    expect(transport.loadSession).toHaveBeenCalledWith(FRESH_AGENT, 's-crashed', '/w')
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
    expect(useAcpStore.getState().messages['s-crashed']).toHaveLength(1)

    // The composer is unblocked: sendPrompt dispatches on the fresh agent.
    await useAcpStore.getState().sendPrompt('s-crashed', 'ping')
    expect(transport.sendPrompt).toHaveBeenCalledWith(
      FRESH_AGENT,
      's-crashed',
      'ping',
      expect.any(String),
      undefined
    )
    await flushTurnEnd()
    expect(useAcpStore.getState().sessions['s-crashed']?.activeTurn).toBe(false)
  })

  it('status:error + turnActive + trailing user + no owner still degrades (owner gate beats the persisted flag)', async () => {
    const transport = fakeWebTransport([], {
      's-crashed-flag': trailingUserPayload('s-crashed-flag', {
        status: 'error',
        turnActive: true
      })
    })
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-crashed-flag')

    const session = useAcpStore.getState().sessions['s-crashed-flag']
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    expect(transport.spawnAgent).toHaveBeenCalledTimes(1)
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
    expect(vi.mocked(logFrontendError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'acp.openHistorySession' })
    )
  })

  it('stale status:active + trailing user + dead agent degrades to ensureLiveAgent + decideResume with cleared flags', async () => {
    const transport = fakeWebTransport(
      [
        // A live agent exists but does NOT own this session — it cannot host
        // the dead turn either.
        ownerSummary('some-other-session', 'agent-other')
      ],
      { 's-stale': trailingUserPayload('s-stale', { status: 'active' }) }
    )
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-stale')

    const session = useAcpStore.getState().sessions['s-stale']
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    expect(transport.spawnAgent).toHaveBeenCalledTimes(1)
    expect(transport.loadSession).toHaveBeenCalledWith(FRESH_AGENT, 's-stale', '/w')
    expect(session?.status).toBe('active')
    expect(session?.agentId).toBe(FRESH_AGENT)
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
    expect(useAcpStore.getState().messages['s-stale']).toHaveLength(1)
  })

  it('stale status:active + trailing user + spawn failure lands read-only local with cleared flags', async () => {
    const transport = fakeWebTransport([], {
      's-noagent': trailingUserPayload('s-noagent', { status: 'active' })
    })
    transport.spawnAgent.mockRejectedValue(new Error('spawn failed'))
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-noagent')

    const session = useAcpStore.getState().sessions['s-noagent']
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    // 'local' strategy: transcript stays readable, no live agent to resume on.
    expect(session?.status).toBe('closed')
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
    expect(useAcpStore.getState().messages['s-noagent']).toHaveLength(1)
  })

  it('stale status:active + trailing user + load failure surfaces the resume-error banner with cleared flags', async () => {
    const transport = fakeWebTransport([], {
      's-loadfail': trailingUserPayload('s-loadfail', { status: 'active' })
    })
    transport.loadSession.mockRejectedValue(new Error('agent gone'))
    _setAcpTransportForTests(transport)

    await expect(useAcpStore.getState().openHistorySession('s-loadfail')).rejects.toThrow(
      'agent gone'
    )

    const session = useAcpStore.getState().sessions['s-loadfail']
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
    expect(session?.lastError).toContain('Resume failed')
    expect(session?.lastError).toContain('agent gone')
    // The local transcript is restored under the banner (never blanked).
    expect(useAcpStore.getState().messages['s-loadfail']).toHaveLength(1)
  })

  it('ACP_REOPEN_TURN_ACTIVE on the degraded path still attaches — in-band proof of liveness', async () => {
    const transport = fakeWebTransport([], {
      's-bandproof': trailingUserPayload('s-bandproof', { status: 'active' })
    })
    transport.loadSession.mockRejectedValue(
      new AcpTransportError('not_implemented', 'ACP_REOPEN_TURN_ACTIVE: session s-bandproof')
    )
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-bandproof')

    const session = useAcpStore.getState().sessions['s-bandproof']
    // The host's single-owner guard rejection trumps the liveness gate: the
    // turn provably lives, so the catch attaches unconditionally.
    expect(transport.loadSession).toHaveBeenCalled()
    expect(transport.subscribeSession).toHaveBeenCalledWith('s-bandproof', 10, true)
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(true)
    // The degrade cleared the optimistic id; attachLiveTurn's fallback wins.
    expect(session?.openTurnId).toBe('turn:live')
  })

  it('status:active + trailing user + host-registered owner attaches unchanged (#882 regression)', async () => {
    const transport = fakeWebTransport([ownerSummary('s-live')], {
      's-live': trailingUserPayload('s-live', { status: 'active' })
    })
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-live')

    const session = useAcpStore.getState().sessions['s-live']
    expect(transport.spawnAgent).not.toHaveBeenCalled()
    expect(transport.loadSession).not.toHaveBeenCalled()
    expect(transport.subscribeSession).toHaveBeenCalledWith('s-live', 10, true)
    expect(session?.agentId).toBe('agent-owner')
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(true)
    expect(session?.lastError).toBeNull()
  })

  it('status:active + trailing user + connected persisted agent attaches to the desktop same-process owner', async () => {
    vi.mocked(isTauriContext).mockReturnValue(true)
    const transport = fakeWebTransport([], {
      's-desk': trailingUserPayload('s-desk', {
        status: 'active',
        agentId: 'agent-desktop-owner'
      })
    })
    _setAcpTransportForTests(transport)
    // Same-process owner: the persisted agent is still connected in-store
    // even though the host listing reports no ownsSession rows.
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        'agent-desktop-owner': {
          id: 'agent-desktop-owner',
          capabilities: { loadSession: true }
        }
      },
      agentStatus: { ...s.agentStatus, 'agent-desktop-owner': 'connected' }
    }))

    await useAcpStore.getState().openHistorySession('s-desk')

    const session = useAcpStore.getState().sessions['s-desk']
    expect(transport.spawnAgent).not.toHaveBeenCalled()
    expect(transport.loadSession).not.toHaveBeenCalled()
    expect(transport.subscribeSession).toHaveBeenCalledWith('s-desk', 10, true)
    expect(session?.agentId).toBe('agent-desktop-owner')
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(true)
  })

  it('status:closed + trailing user reopens idle on the success path', async () => {
    const transport = fakeWebTransport([], {
      's-closed-ok': trailingUserPayload('s-closed-ok', { status: 'closed' })
    })
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-closed-ok')

    const session = useAcpStore.getState().sessions['s-closed-ok']
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    expect(transport.loadSession).toHaveBeenCalledWith(FRESH_AGENT, 's-closed-ok', '/w')
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
  })

  it('status:closed + trailing user keeps flags cleared on the failure path', async () => {
    const transport = fakeWebTransport([], {
      's-closed-fail': trailingUserPayload('s-closed-fail', { status: 'closed' })
    })
    transport.loadSession.mockRejectedValue(new Error('load broke'))
    _setAcpTransportForTests(transport)

    await expect(useAcpStore.getState().openHistorySession('s-closed-fail')).rejects.toThrow(
      'load broke'
    )

    const session = useAcpStore.getState().sessions['s-closed-fail']
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
    expect(session?.lastError).toContain('Resume failed')
    expect(useAcpStore.getState().messages['s-closed-fail']).toHaveLength(1)
  })

  it("status:closed + trailing user keeps flags cleared on the 'local' path", async () => {
    const transport = fakeWebTransport([], {
      's-closed-local': trailingUserPayload('s-closed-local', { status: 'closed' })
    })
    transport.spawnAgent.mockRejectedValue(new Error('spawn failed'))
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-closed-local')

    const session = useAcpStore.getState().sessions['s-closed-local']
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    expect(session?.status).toBe('closed')
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
    expect(useAcpStore.getState().messages['s-closed-local']).toHaveLength(1)
  })

  // --- resumeLiveSession: same matrix through the explicit-agent path -------

  it('resumeLiveSession: status:error + trailing user + not-connected agent resumes normally', async () => {
    const transport = fakeWebTransport([], {
      's-rerr': trailingUserPayload('s-rerr', { status: 'error' })
    })
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().resumeLiveSession('s-rerr', 'agent-r', '/w')

    const session = useAcpStore.getState().sessions['s-rerr']
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    expect(transport.resumeSession).toHaveBeenCalledWith('agent-r', 's-rerr', '/w')
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
  })

  it('resumeLiveSession: status:active + trailing user + not-connected agent clears flags and resumes', async () => {
    const transport = fakeWebTransport([], {
      's-rstale': trailingUserPayload('s-rstale', { status: 'active' })
    })
    _setAcpTransportForTests(transport)
    // The caller's agent is dead — no agentStatus entry (e.g. crashed).

    await useAcpStore.getState().resumeLiveSession('s-rstale', 'agent-r', '/w')

    const session = useAcpStore.getState().sessions['s-rstale']
    // The durable bug: previously this attached and waited on a dead agent's
    // prompt_complete forever. Now the resume-try runs instead.
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    expect(transport.resumeSession).toHaveBeenCalledWith('agent-r', 's-rstale', '/w')
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
    expect(vi.mocked(logFrontendError)).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'acp.resumeLiveSession' })
    )
  })

  it('resumeLiveSession: status:active + trailing user + connected agent attaches', async () => {
    const transport = fakeWebTransport([], {
      's-rlive': trailingUserPayload('s-rlive', { status: 'active' })
    })
    _setAcpTransportForTests(transport)
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        'agent-r': { id: 'agent-r', capabilities: { loadSession: true } }
      },
      agentStatus: { ...s.agentStatus, 'agent-r': 'connected' }
    }))

    await useAcpStore.getState().resumeLiveSession('s-rlive', 'agent-r', '/w')

    const session = useAcpStore.getState().sessions['s-rlive']
    expect(transport.resumeSession).not.toHaveBeenCalled()
    expect(transport.subscribeSession).toHaveBeenCalledWith('s-rlive', 10, true)
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(true)
  })

  it('resumeLiveSession: turnActive + connected agent attaches', async () => {
    const transport = fakeWebTransport([], {
      's-rflag': trailingUserPayload('s-rflag', { status: 'active', turnActive: true })
    })
    _setAcpTransportForTests(transport)
    useAcpStore.setState((s) => ({
      agents: { ...s.agents, 'agent-r': { id: 'agent-r', capabilities: {} } },
      agentStatus: { ...s.agentStatus, 'agent-r': 'connected' }
    }))

    await useAcpStore.getState().resumeLiveSession('s-rflag', 'agent-r', '/w')

    const session = useAcpStore.getState().sessions['s-rflag']
    expect(transport.subscribeSession).toHaveBeenCalledWith('s-rflag', 10, true)
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(true)
  })

  it('resumeLiveSession: status:closed + trailing user resumes with cleared flags', async () => {
    const transport = fakeWebTransport([], {
      's-rclosed': trailingUserPayload('s-rclosed', { status: 'closed' })
    })
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().resumeLiveSession('s-rclosed', 'agent-r', '/w')

    const session = useAcpStore.getState().sessions['s-rclosed']
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    expect(transport.resumeSession).toHaveBeenCalledWith('agent-r', 's-rclosed', '/w')
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
  })

  it('resumeLiveSession: dead agent + ACP_REOPEN_TURN_ACTIVE rejection still attaches', async () => {
    const transport = fakeWebTransport([], {
      's-rband': trailingUserPayload('s-rband', { status: 'active' })
    })
    transport.resumeSession.mockRejectedValue(
      new AcpTransportError('not_implemented', 'ACP_REOPEN_TURN_ACTIVE: session s-rband')
    )
    _setAcpTransportForTests(transport)
    // Stale agentStatus: the agent is actually alive host-side — the
    // in-band rejection proves it, so the catch attaches unconditionally.

    await useAcpStore.getState().resumeLiveSession('s-rband', 'agent-r', '/w')

    const session = useAcpStore.getState().sessions['s-rband']
    expect(transport.resumeSession).toHaveBeenCalled()
    expect(transport.subscribeSession).toHaveBeenCalledWith('s-rband', 10, true)
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(true)
  })

  it('resumeLiveSession: dead agent + resume failure surfaces the banner with cleared flags', async () => {
    const transport = fakeWebTransport([], {
      's-rfail': trailingUserPayload('s-rfail', { status: 'active' })
    })
    transport.resumeSession.mockRejectedValue(new Error('agent gone'))
    _setAcpTransportForTests(transport)

    await expect(
      useAcpStore.getState().resumeLiveSession('s-rfail', 'agent-r', '/w')
    ).rejects.toThrow('agent gone')

    const session = useAcpStore.getState().sessions['s-rfail']
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
    expect(session?.lastError).toContain('Resume failed')
    expect(useAcpStore.getState().messages['s-rfail']).toHaveLength(1)
  })

  it('a trusted empty listing beats a connected persisted agent — no attach to a non-owner', async () => {
    // The host listing ran and proved NO agent owns this session, while the
    // store still shows the persisted agent connected (it is alive running
    // other chats). Attaching to it would replay a transcript whose turn is
    // over — the replay-only dead end this gate exists to close.
    const transport = fakeWebTransport([], {
      's-listed': trailingUserPayload('s-listed', { status: 'active' })
    })
    _setAcpTransportForTests(transport)
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        [PERSISTED_AGENT]: { id: PERSISTED_AGENT, capabilities: { loadSession: true } }
      },
      agentStatus: { ...s.agentStatus, [PERSISTED_AGENT]: 'connected' }
    }))

    await useAcpStore.getState().openHistorySession('s-listed')

    const session = useAcpStore.getState().sessions['s-listed']
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
  })

  it('a failed listing still honors the connected persisted agent as owner', async () => {
    // `listAgentDetails` threw — nothing was actually consulted, so the
    // in-store connected record is the best ownership evidence available.
    const transport = fakeWebTransport([], {
      's-unlist': trailingUserPayload('s-unlist', { status: 'active' })
    })
    transport.listAgentDetails = vi.fn().mockRejectedValue(new Error('ws down'))
    _setAcpTransportForTests(transport)
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        [PERSISTED_AGENT]: { id: PERSISTED_AGENT, capabilities: { loadSession: true } }
      },
      agentStatus: { ...s.agentStatus, [PERSISTED_AGENT]: 'connected' }
    }))

    await useAcpStore.getState().openHistorySession('s-unlist')

    const session = useAcpStore.getState().sessions['s-unlist']
    expect(transport.subscribeSession).toHaveBeenCalledWith('s-unlist', 10, true)
    expect(session?.agentId).toBe(PERSISTED_AGENT)
    expect(session?.activeTurn).toBe(true)
  })

  it('ACP_SESSION_OWNED_BY_OTHER re-adopts the named owner and attaches', async () => {
    // Shared-live race: the adoption listing ran before a second client's
    // agent registered ownership; the load rejection names the owner, so
    // re-list, adopt, and attach instead of failing the reopen.
    const transport = fakeWebTransport([], {
      's-owned': trailingUserPayload('s-owned', { status: 'active' })
    })
    transport.listAgentDetails = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([ownerSummary('s-owned')])
    transport.loadSession.mockRejectedValue(
      new AcpTransportError(
        'not_implemented',
        'ACP_SESSION_OWNED_BY_OTHER: session s-owned is owned by live agent agent-owner with a turn in flight'
      )
    )
    _setAcpTransportForTests(transport)

    await useAcpStore.getState().openHistorySession('s-owned')

    const session = useAcpStore.getState().sessions['s-owned']
    expect(transport.loadSession).toHaveBeenCalled()
    expect(transport.subscribeSession).toHaveBeenCalledWith('s-owned', 10, true)
    expect(session?.agentId).toBe('agent-owner')
    expect(session?.status).toBe('active')
    expect(session?.activeTurn).toBe(true)
    expect(session?.lastError).toBeNull()
  })

  it('owner dying during the capability wait clears the turn instead of attaching to a corpse', async () => {
    // `turnOwnerConnected` latches at adoption; the owner can still crash
    // before the attach runs. `_onAgentCrashed` already fired while
    // `session.agentId` still held the persisted id, so nothing clears the
    // installed flags unless the attach branch re-checks connectivity.
    const transport = fakeWebTransport([{ ...ownerSummary('s-race'), capabilities: null }], {
      's-race': trailingUserPayload('s-race', { status: 'active' })
    })
    _setAcpTransportForTests(transport)

    const open = useAcpStore.getState().openHistorySession('s-race')
    // The adopted owner is seeded connected but capabilities-less → the 3s
    // fallback wait is now armed; the crash lands inside it.
    await vi.waitFor(() => {
      expect(useAcpStore.getState().agentStatus['agent-owner']).toBe('connected')
    })
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        'agent-owner': { id: 'agent-owner', capabilities: { loadSession: true } }
      },
      agentStatus: { ...s.agentStatus, 'agent-owner': 'error' }
    }))
    await open

    const session = useAcpStore.getState().sessions['s-race']
    expect(transport.subscribeSession).not.toHaveBeenCalled()
    expect(session?.activeTurn).toBe(false)
    expect(session?.openTurnId).toBeNull()
  })

  it('desktop-shaped transport (no subscribeSession/listAgentDetails) degrades a dead turn and attaches a live one', async () => {
    vi.mocked(isTauriContext).mockReturnValue(true)
    const transport = fakeWebTransport([], {
      's-tdead': trailingUserPayload('s-tdead', { status: 'error' }),
      's-tlive': trailingUserPayload('s-tlive', { status: 'active' })
    })
    // The real Tauri transport has no web-only helpers.
    delete (transport as Partial<FakeTransport>).listAgentDetails
    delete (transport as Partial<FakeTransport>).subscribeSession
    delete (transport as Partial<FakeTransport>).seedSessionCursor
    _setAcpTransportForTests(transport)
    useAcpStore.setState((s) => ({
      agents: {
        ...s.agents,
        [PERSISTED_AGENT]: { id: PERSISTED_AGENT, capabilities: { loadSession: true } }
      },
      agentStatus: { ...s.agentStatus, [PERSISTED_AGENT]: 'connected' }
    }))

    // Dead turn: 'error' is never live → the fresh agent hosts it.
    await useAcpStore.getState().openHistorySession('s-tdead')
    const dead = useAcpStore.getState().sessions['s-tdead']
    expect(dead?.activeTurn).toBe(false)
    expect(dead?.openTurnId).toBeNull()
    const spawnsAfterDead = transport.spawnAgent.mock.calls.length

    // Live turn: the desktop same-process owner attaches through the
    // broadcast path (no subscribe call exists to make).
    await useAcpStore.getState().openHistorySession('s-tlive')
    const live = useAcpStore.getState().sessions['s-tlive']
    expect(live?.agentId).toBe(PERSISTED_AGENT)
    expect(live?.status).toBe('active')
    expect(live?.activeTurn).toBe(true)
    expect(transport.spawnAgent.mock.calls.length).toBe(spawnsAfterDead)
  })

  // --- stale in-memory record -----------------------------------------------
  // The `_onAgentCrashed` record survives tab close + reopen clicks: status
  // 'error', agentId still pointing at the dead owner. openHistorySession's
  // "already live" early-return must NOT count 'error' as live — binding that
  // record made the next composer send dispatch to the dead agent
  // (`AcpTransportError: unknown agent`).

  it('cached status:error record re-runs the full reopen instead of binding the dead agentId', async () => {
    const transport = fakeWebTransport([], {
      's-stale-err': trailingUserPayload('s-stale-err', { status: 'error' })
    })
    _setAcpTransportForTests(transport)
    useAcpStore.setState({
      sessions: {
        's-stale-err': {
          id: 's-stale-err',
          agentId: 'agent-dead',
          cwd: '/w',
          projectId: 'p1',
          status: 'error',
          title: 'Chat',
          activeTurn: false,
          openTurnId: null,
          modes: null,
          models: null,
          configOptions: [],
          lastError: 'agent crashed',
          createdAt: 1
        }
      }
    })

    await useAcpStore.getState().openHistorySession('s-stale-err')

    const session = useAcpStore.getState().sessions['s-stale-err']
    // A full reopen ran: a fresh agent resolved through the config, agentId
    // repointed, and a normal session/load replayed the transcript.
    expect(transport.spawnAgent).toHaveBeenCalledTimes(1)
    expect(transport.loadSession).toHaveBeenCalledWith(FRESH_AGENT, 's-stale-err', '/w')
    expect(session?.agentId).toBe(FRESH_AGENT)
    expect(session?.status).toBe('active')

    // A follow-up send dispatches on the repointed agent — never the dead one.
    await useAcpStore.getState().sendPrompt('s-stale-err', 'still here?')
    expect(transport.sendPrompt).toHaveBeenCalledWith(
      FRESH_AGENT,
      's-stale-err',
      'still here?',
      expect.any(String),
      undefined
    )
  })

  it('a send typed mid-reopen queues and dispatches on the repointed agent when the open lands', async () => {
    const transport = fakeWebTransport([], {
      's-mid': trailingUserPayload('s-mid', { status: 'error' })
    })
    // Hold the spawn so the send lands mid-open (marker set, record 'closed').
    let resolveSpawn!: (v: { agentId: string; capabilities: { loadSession: boolean } }) => void
    transport.spawnAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSpawn = resolve
        })
    )
    _setAcpTransportForTests(transport)
    useAcpStore.setState({
      sessions: {
        's-mid': {
          id: 's-mid',
          agentId: 'agent-dead',
          cwd: '/w',
          projectId: 'p1',
          status: 'error',
          title: 'Chat',
          activeTurn: false,
          openTurnId: null,
          modes: null,
          models: null,
          configOptions: [],
          lastError: 'agent crashed',
          createdAt: 1
        }
      }
    })

    const open = useAcpStore.getState().openHistorySession('s-mid')
    // Wait until the spawn is in flight: the marker is set and the install
    // has stamped the record 'closed' while agentId is still unresolved.
    await vi.waitFor(() => {
      expect(transport.spawnAgent).toHaveBeenCalled()
    })

    // Typed while the install sits 'closed' and the spawn is still held:
    // queues instead of throwing 'session is closed' or dispatching stale.
    await useAcpStore.getState().sendPrompt('s-mid', 'typed while opening')
    expect(useAcpStore.getState().promptQueues['s-mid']).toHaveLength(1)
    expect(transport.sendPrompt).not.toHaveBeenCalled()
    expect(transport.sendPromptBlocks).not.toHaveBeenCalled()

    resolveSpawn({ agentId: FRESH_AGENT, capabilities: { loadSession: true } })
    await open

    // The open's finally flushed the queue onto the repointed live agent —
    // queued sends dispatch through sendPromptBlocks (blocks, not text).
    await vi.waitFor(() => {
      expect(transport.sendPromptBlocks).toHaveBeenCalledWith(
        FRESH_AGENT,
        's-mid',
        [{ type: 'text', text: 'typed while opening' }],
        expect.any(String),
        undefined
      )
    })
    expect(useAcpStore.getState().promptQueues['s-mid']).toHaveLength(0)
  })
})
