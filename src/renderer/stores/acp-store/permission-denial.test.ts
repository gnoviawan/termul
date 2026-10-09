import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    loadSessionPayload: vi.fn(async (id: string) => actual.getCachedSessionPayload(id) ?? null),
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

// The real workspace store drags terminal-store and router side effects into
// this suite, so the pane helpers the acp-store imports are mirrored locally.
vi.mock('@/stores/workspace-store', () => {
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
        addAgentChatTab: vi.fn(),
        removeTab: vi.fn(),
        remapAgentChatSession: vi.fn(),
        root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null }
      })
    }
  }
})

vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: vi.fn(),
  getTabFocusedSessionId: vi.fn(() => null)
}))

const { mockPersistenceApi, mockListCatalog } = vi.hoisted(() => ({
  mockPersistenceApi: {
    read: vi.fn(async () => ({ success: false })),
    write: vi.fn(),
    writeDebounced: vi.fn(async () => ({ success: true })),
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
import {
  _resetAcpTransportForTests,
  _setAcpTransportForTests,
  type AcpTransport
} from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import {
  _resetAcpAuthForTesting,
  _resetCoalesceForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetHistorySeqWatermarksForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetInFlightPreparedForTesting,
  _resetLiveSwitchSourcesForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  initAcpEventListeners,
  useAcpStore
} from '@/stores/acp-store'
import {
  _resetPermissionDenialTrackingForTesting,
  _trackedPermissionIdsForTesting,
  attachPermissionDenialTracking,
  forgetTrackedPermission,
  forgetTrackedPermissionsForSession,
  retrackPermission
} from './permission-denial'
import { FRESH, flushTurnEnd, seedOptionsSession, seedSession } from './testkit'

const TOOL = 'npm test -- auth'

function requestPermission(requestId: string, sessionId = 's1', title = TOOL): void {
  useAcpStore.getState()._onPermissionRequest({
    agentId: 'agent-1',
    sessionId,
    requestId,
    toolCall: { toolCallId: `tc-${requestId}`, title },
    options: [{ optionId: 'allow', name: 'Allow' }]
  })
}

function loseTransport(): void {
  useAcpStore.setState({ transportReconnecting: true })
}

function recoverTransport(): void {
  useAcpStore.setState({ transportReconnecting: false })
}

function completeTurn(sessionId = 's1', stopReason: 'end_turn' | 'cancelled' = 'end_turn'): void {
  useAcpStore.getState()._onPromptComplete({ agentId: 'agent-1', sessionId, stopReason })
}

function seedTwoSessions(activeTurn = true): void {
  seedOptionsSession('s1', 'agent-1', { activeTurn, openTurnId: activeTurn ? 't1' : null })
  seedOptionsSession('s2', 'agent-1', { activeTurn, openTurnId: activeTurn ? 't2' : null })
}

function notices(): Record<string, { requestId: string; tool: string }> {
  return useAcpStore.getState().permissionDenialNotices
}

function resetStore(): void {
  vi.clearAllMocks()
  ;(invoke as ReturnType<typeof vi.fn>).mockReset()
  mockPersistenceApi.read.mockResolvedValue({ success: false })
  mockPersistenceApi.writeDebounced.mockResolvedValue({ success: true })
  mockPersistenceApi.delete.mockResolvedValue({ success: true })
  _resetAcpTransportForTests(null)
  _resetInFlightHistoryOpensForTesting()
  _resetAcpAuthForTesting()
  _resetInFlightPreparedForTesting()
  _resetCoalesceForTesting()
  _resetEphemeralSessionIdsForTesting()
  _resetSessionIndexLoadGenerationForTesting()
  _resetHistorySeqWatermarksForTesting()
  _resetLiveSwitchSourcesForTesting()
  _resetPermissionDenialTrackingForTesting()
  useAcpStore.setState(FRESH)
}

describe('permission denial tracking (L-09)', () => {
  let detach: () => void

  beforeEach(() => {
    resetStore()
    detach = attachPermissionDenialTracking(useAcpStore)
  })

  afterEach(() => {
    detach()
  })

  describe('a denial', () => {
    it('raises a notice for a permission pending at a loss that leaves unanswered', () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1')
      loseTransport()
      expect(_trackedPermissionIdsForTesting()).toEqual(['r1'])

      completeTurn()

      expect(notices()).toEqual({ s1: { requestId: 'r1', tool: TOOL } })
      expect(_trackedPermissionIdsForTesting()).toEqual([])
    })

    it('logs ids at info and never the tool text', () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1', 's1', 'rm -rf secrets/prod.key')
      loseTransport()
      completeTurn()

      const calls = vi.mocked(logFrontendError).mock.calls.map(([entry]) => entry)
      const entry = calls.find((e) => e.source === 'acp.permissionDeniedByDisconnect')
      expect(entry).toMatchObject({ level: 'info' })
      expect(entry?.message).toContain('r1')
      expect(entry?.message).toContain('s1')
      expect(JSON.stringify(calls)).not.toContain('secrets/prod.key')
    })

    it('falls back to the tool call id and then to a generic phrase for the tool', () => {
      seedTwoSessions()
      useAcpStore.getState()._onPermissionRequest({
        agentId: 'agent-1',
        sessionId: 's1',
        requestId: 'r1',
        toolCall: { toolCallId: 'tc-1' },
        options: []
      })
      useAcpStore.getState()._onPermissionRequest({
        agentId: 'agent-1',
        sessionId: 's2',
        requestId: 'r2',
        // An un-storable call (no string id) is kept as null on the request.
        toolCall: {},
        options: []
      })
      loseTransport()
      completeTurn('s1')
      completeTurn('s2')

      expect(notices().s1.tool).toBe('tc-1')
      expect(notices().s2.tool).toBe('this action')
    })

    it('survives unrelated writes and the turn ending, so the line stays across re-renders', async () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1')
      loseTransport()
      completeTurn()
      await flushTurnEnd()
      expect(useAcpStore.getState().sessions.s1.activeTurn).toBe(false)

      useAcpStore.setState((s) => ({
        sessions: { s1: { ...s.sessions.s1, title: 'Renamed' } },
        transportReconnecting: false
      }))

      expect(notices().s1).toEqual({ requestId: 'r1', tool: TOOL })
    })

    it('keeps the notice of a chat that is not the active one', () => {
      seedTwoSessions()
      useAcpStore.setState({ activeSessionId: 's1' })
      requestPermission('r2', 's2')
      loseTransport()
      completeTurn('s2')

      expect(Object.keys(notices())).toEqual(['s2'])
    })

    it('lets the first vanished request of a pass win', () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1', 's1', 'first tool')
      requestPermission('r2', 's1', 'second tool')
      loseTransport()
      completeTurn()

      expect(notices().s1).toEqual({ requestId: 'r1', tool: 'first tool' })
    })

    it('replaces an older notice with a newer denial from a later loss', () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1', 's1', 'first tool')
      loseTransport()
      completeTurn()
      expect(notices().s1.requestId).toBe('r1')

      recoverTransport()
      requestPermission('r2', 's1', 'second tool')
      loseTransport()
      completeTurn()

      expect(notices().s1).toEqual({ requestId: 'r2', tool: 'second tool' })
    })
  })

  describe('the notice ends', () => {
    it('clears when the session next turn starts', async () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1')
      loseTransport()
      completeTurn()
      await flushTurnEnd()
      expect(notices().s1).toBeDefined()

      useAcpStore.setState((s) => ({
        sessions: { s1: { ...s.sessions.s1, activeTurn: true, openTurnId: 't2' } }
      }))

      expect(notices()).toEqual({})
    })

    it('clears when the session goes away', () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1')
      loseTransport()
      completeTurn()
      expect(notices().s1).toBeDefined()

      useAcpStore.setState({ sessions: {} })

      expect(notices()).toEqual({})
    })

    it('does not touch the notice of another session when one session starts a turn', () => {
      seedTwoSessions(false)
      useAcpStore.setState({ permissionDenialNotices: { s1: { requestId: 'r1', tool: TOOL } } })

      useAcpStore.setState((s) => ({
        sessions: { ...s.sessions, s2: { ...s.sessions.s2, activeTurn: true } }
      }))

      expect(notices().s1).toBeDefined()
    })
  })

  describe('stays silent', () => {
    it('when the user answered', async () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1')
      loseTransport()
      vi.mocked(invoke).mockResolvedValue(undefined)

      await useAcpStore.getState().respondPermission('r1', 'allow')
      completeTurn()

      expect(notices()).toEqual({})
      expect(_trackedPermissionIdsForTesting()).toEqual([])
    })

    it('when the user pressed Stop', async () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1')
      loseTransport()
      vi.mocked(invoke).mockResolvedValue(undefined)

      await useAcpStore.getState().cancelPrompt('s1')
      completeTurn('s1', 'cancelled')

      expect(notices()).toEqual({})
    })

    it('when the user pressed Send now', async () => {
      seedSession('s1', 'agent-1', true)
      useAcpStore.setState({
        promptQueues: {
          s1: [{ id: 'q1', blocks: [{ type: 'text', text: 'next' }], createdAt: Date.now() }]
        }
      })
      requestPermission('r1')
      loseTransport()
      let noticesAfterCancel: unknown = 'unset'
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === 'acp_cancel_prompt') {
          completeTurn('s1', 'cancelled')
          noticesAfterCancel = { ...notices() }
          return undefined
        }
        if (cmd === 'acp_send_prompt') return 'end_turn'
        return undefined
      })

      await useAcpStore.getState().sendQueuedPromptNow('s1', 'q1')
      await flushTurnEnd()

      expect(noticesAfterCancel).toEqual({})
      expect(notices()).toEqual({})
    })

    it('when the session closed', () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1')
      loseTransport()

      useAcpStore.getState()._onSessionClosed({ agentId: 'agent-1', sessionId: 's1' })

      expect(useAcpStore.getState().sessions.s1.status).toBe('closed')
      expect(notices()).toEqual({})
      expect(_trackedPermissionIdsForTesting()).toEqual([])
    })

    it('when the session errored', () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1')
      loseTransport()

      useAcpStore.setState((s) => ({
        sessions: { s1: { ...s.sessions.s1, status: 'error' } },
        pendingPermissions: {}
      }))

      expect(notices()).toEqual({})
    })

    it('when the session was removed', () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1')
      loseTransport()

      useAcpStore.setState({ sessions: {}, pendingPermissions: {} })

      expect(notices()).toEqual({})
    })

    it('when no loss happened (the Tauri IPC transport never reports one)', () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1')
      expect(_trackedPermissionIdsForTesting()).toEqual([])

      completeTurn()

      expect(notices()).toEqual({})
    })

    it('for a permission that arrived after the loss', () => {
      seedSession('s1', 'agent-1')
      loseTransport()
      requestPermission('r1')
      expect(_trackedPermissionIdsForTesting()).toEqual([])

      completeTurn()

      expect(notices()).toEqual({})
    })

    it('for a loss with nothing pending', () => {
      seedSession('s1', 'agent-1')
      loseTransport()
      useAcpStore.setState({ pendingPermissions: {} })

      expect(notices()).toEqual({})
    })
  })

  describe('a rejected response', () => {
    it('restores the entry, keeps it tracked, and a later unanswered exit still raises the notice', async () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1')
      loseTransport()
      vi.mocked(invoke).mockRejectedValue(new Error('offline'))

      await expect(useAcpStore.getState().respondPermission('r1', 'allow')).rejects.toThrow(
        'offline'
      )

      expect(useAcpStore.getState().pendingPermissions.r1).toBeDefined()
      expect(_trackedPermissionIdsForTesting()).toEqual(['r1'])
      expect(notices()).toEqual({})

      completeTurn()

      expect(notices().s1).toEqual({ requestId: 'r1', tool: TOOL })
    })

    it('does not track a request that was never tracked', async () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1')
      vi.mocked(invoke).mockRejectedValue(new Error('offline'))

      await expect(useAcpStore.getState().respondPermission('r1', 'allow')).rejects.toThrow()

      expect(_trackedPermissionIdsForTesting()).toEqual([])
    })
  })

  describe('a rejected cancel', () => {
    it('keeps a still-pending permission tracked after Stop fails, so a later denial raises the notice', async () => {
      seedSession('s1', 'agent-1', true)
      requestPermission('r1')
      loseTransport()
      vi.mocked(invoke).mockRejectedValue(new Error('offline'))

      await expect(useAcpStore.getState().cancelPrompt('s1')).rejects.toThrow('offline')

      expect(useAcpStore.getState().pendingPermissions.r1).toBeDefined()
      expect(_trackedPermissionIdsForTesting()).toEqual(['r1'])

      completeTurn()

      expect(notices().s1).toEqual({ requestId: 'r1', tool: TOOL })
    })

    it('keeps a still-pending permission tracked after Send now fails to cancel', async () => {
      seedSession('s1', 'agent-1', true)
      useAcpStore.setState({
        promptQueues: {
          s1: [{ id: 'q1', blocks: [{ type: 'text', text: 'next' }], createdAt: Date.now() }]
        }
      })
      requestPermission('r1')
      loseTransport()
      vi.mocked(invoke).mockRejectedValue(new Error('offline'))

      await expect(useAcpStore.getState().sendQueuedPromptNow('s1', 'q1')).rejects.toThrow(
        'offline'
      )

      expect(_trackedPermissionIdsForTesting()).toEqual(['r1'])
    })

    it('does not re-track a permission that left the store while the cancel was in flight', async () => {
      seedSession('s1', 'agent-1', true)
      requestPermission('r1')
      loseTransport()
      vi.mocked(invoke).mockImplementation(async () => {
        completeTurn()
        throw new Error('offline')
      })

      await expect(useAcpStore.getState().cancelPrompt('s1')).rejects.toThrow('offline')

      expect(useAcpStore.getState().pendingPermissions.r1).toBeUndefined()
      expect(_trackedPermissionIdsForTesting()).toEqual([])
      expect(notices()).toEqual({})
    })
  })

  describe('tracking helpers', () => {
    it('forgets one id and returns its entry, then retracks it', () => {
      seedSession('s1', 'agent-1')
      requestPermission('r1')
      loseTransport()

      const entry = forgetTrackedPermission('r1')
      expect(entry).toEqual({ sessionId: 's1', tool: TOOL })
      expect(forgetTrackedPermission('r1')).toBeUndefined()

      retrackPermission('r1', entry as NonNullable<typeof entry>)
      expect(_trackedPermissionIdsForTesting()).toEqual(['r1'])
    })

    it('forgets every id of one session and leaves the others', () => {
      seedTwoSessions()
      requestPermission('r1', 's1')
      requestPermission('r2', 's1')
      requestPermission('r3', 's2')
      loseTransport()

      forgetTrackedPermissionsForSession('s1')

      expect(_trackedPermissionIdsForTesting()).toEqual(['r3'])
    })
  })

  it('logs and swallows a failing listener instead of failing the store write', () => {
    seedSession('s1', 'agent-1')
    const poisoned = {
      get title(): string {
        throw new Error('boom')
      }
    }
    useAcpStore.setState({
      pendingPermissions: {
        r1: {
          requestId: 'r1',
          agentId: 'agent-1',
          sessionId: 's1',
          options: [],
          toolCall: poisoned
        }
      }
    })

    expect(() => loseTransport()).not.toThrow()

    expect(useAcpStore.getState().transportReconnecting).toBe(true)
    const entry = vi
      .mocked(logFrontendError)
      .mock.calls.map(([e]) => e)
      .find((e) => e.source === 'acp.permissionDenialTracking')
    expect(entry).toMatchObject({ level: 'warn' })
    expect(entry?.message).toContain('boom')
  })
})

describe('permission denial tracking: wiring through initAcpEventListeners', () => {
  beforeEach(() => {
    resetStore()
  })

  function stubTransport(): {
    listeners: Map<string, (payload: unknown, eventSeq?: number) => void>
    reconnectListener: () => ((reconnecting: boolean) => void) | null
  } {
    const listeners = new Map<string, (payload: unknown, eventSeq?: number) => void>()
    let reconnectListener: ((reconnecting: boolean) => void) | null = null
    _setAcpTransportForTests({
      onEvent: vi.fn((name: string, callback: (payload: unknown, eventSeq?: number) => void) => {
        listeners.set(name, callback)
        return () => listeners.delete(name)
      }),
      setReconnectListener: vi.fn((listener: (reconnecting: boolean) => void) => {
        reconnectListener = listener
      }),
      setRecoveryHandler: vi.fn(),
      setReconnectPriorityProvider: vi.fn(),
      dispose: vi.fn()
    } as unknown as AcpTransport)
    return { listeners, reconnectListener: () => reconnectListener }
  }

  it('raises the notice from transport events and stops after the teardown', () => {
    const { listeners, reconnectListener } = stubTransport()
    seedSession('s1', 'agent-1')
    const teardown = initAcpEventListeners()
    try {
      listeners.get('acp:permission_request')?.({
        agentId: 'agent-1',
        sessionId: 's1',
        requestId: 'r1',
        toolCall: { toolCallId: 'tc-1', title: TOOL },
        options: [{ optionId: 'allow', name: 'Allow' }]
      })
      expect(useAcpStore.getState().pendingPermissions.r1).toBeDefined()

      // The WS transport reports the drop through the coordinator's listener.
      reconnectListener()?.(true)
      expect(useAcpStore.getState().transportReconnecting).toBe(true)

      listeners.get('acp:prompt_complete')?.({
        agentId: 'agent-1',
        sessionId: 's1',
        stopReason: 'end_turn'
      })

      expect(notices()).toEqual({ s1: { requestId: 'r1', tool: TOOL } })
    } finally {
      teardown()
    }

    // Detached: a second denial raises nothing and the tracking map is empty.
    useAcpStore.setState({ permissionDenialNotices: {}, transportReconnecting: false })
    expect(_trackedPermissionIdsForTesting()).toEqual([])
    requestPermission('r2')
    loseTransport()
    completeTurn()
    expect(notices()).toEqual({})
  })
})
