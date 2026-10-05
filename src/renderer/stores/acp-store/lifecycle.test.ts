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
import {
  _clearPayloadCacheForTesting,
  loadSessionIndex,
  setCachedSessionPayload
} from '@/lib/acp-history-persistence'
import { _resetAcpTransportForTests, AcpTransportError } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import {
  _resetAcpAuthForTesting,
  _resetDroppedLaunchPlaceholdersForTesting,
  _resetInFlightPreparedForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  noteDroppedLaunchPlaceholders,
  takeAllDroppedLaunchPlaceholders,
  useAcpStore
} from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { FRESH, seedSession } from './testkit'

describe('failed session lifecycle (story 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(invoke as ReturnType<typeof vi.fn>).mockReset()
    _resetAcpTransportForTests(null)
    _resetAcpAuthForTesting()
    _resetInFlightPreparedForTesting()
    _resetSessionIndexLoadGenerationForTesting()
    _resetDroppedLaunchPlaceholdersForTesting()
    _clearPayloadCacheForTesting()
    useProjectStore.setState({ activeProjectId: '' })
    useAcpStore.setState(FRESH)
    workspaceStateRef.current = {
      root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
      removeTab: vi.fn(),
      remapAgentChatSession: vi.fn()
    }
  })

  /** Seed a config + placeholder and fail the launch with `err`. */
  async function seedFailedLaunch(err: unknown): Promise<string> {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    const placeholderId = useAcpStore.getState().createLaunchPlaceholder({
      cwd: '/work',
      projectId: 'p1',
      initialUserBlocks: [{ type: 'text', text: 'hello agent' }]
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(err)
    await expect(
      useAcpStore.getState().finalizeChatLaunch({
        placeholderId,
        configId: 'cfg-1',
        cwd: '/work',
        projectId: 'p1'
      })
    ).rejects.toBeTruthy()
    return placeholderId
  }

  it('LAUNCH_FAIL: a failed launch stays open as an error session with an in-memory index entry', async () => {
    const placeholderId = await seedFailedLaunch(new Error('connection refused by agent'))
    const state = useAcpStore.getState()
    const session = state.sessions[placeholderId]
    // The placeholder is NOT torn down: it becomes an error session the user
    // can retry, with the launch config recorded for the retry.
    expect(session.status).toBe('error')
    expect(session.launchConfigId).toBe('cfg-1')
    expect(session.lastError).toContain('connection refused by agent')
    expect(state.launchingSessionIds[placeholderId]).toBeUndefined()
    // The sidebar projection gains a 'error'-status row instead of showing
    // "No chats yet" while the failed tab is open.
    const entry = state.sessionIndex.find((e) => e.id === placeholderId)
    expect(entry).toBeDefined()
    expect(entry?.status).toBe('error')
    expect(entry?.title).toBe('hello agent')
  })

  it('LAUNCH_FAIL: agent_auth_required classifies to actionable sign-in text', async () => {
    const placeholderId = await seedFailedLaunch(
      new AcpTransportError('agent_auth_required', 'create_session rejected: not authenticated')
    )
    const session = useAcpStore.getState().sessions[placeholderId]
    expect(session.status).toBe('error')
    expect(session.lastError).toContain('Authentication required')
    expect(session.lastError).toContain('create_session rejected: not authenticated')
  })

  it('LAUNCH_FAIL: the legacy ACP_AUTH_REQUIRED message prefix also classifies as auth', async () => {
    const placeholderId = await seedFailedLaunch(
      new Error('ACP_AUTH_REQUIRED: run `gemini auth login` first')
    )
    const session = useAcpStore.getState().sessions[placeholderId]
    expect(session.lastError).toContain('Authentication required')
    expect(session.lastError).toContain('gemini auth login')
  })

  it('RETRY_SUCCESS: retry re-runs prepare, replaces the placeholder and drops the failed entry', async () => {
    const placeholderId = await seedFailedLaunch(new Error('connection refused by agent'))
    expect(useAcpStore.getState().sessionIndex.some((e) => e.id === placeholderId)).toBe(true)
    // The placeholder's chat tab is still open, so the adopt remap fires.
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: `chat-${placeholderId}`,
      tabs: [{ type: 'agent-chat', id: `chat-${placeholderId}`, sessionId: placeholderId }]
    }

    // Second launch attempt succeeds: spawn + session/new + the re-sent turn.
    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-retry', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return { sessionId: 'sess-retry' }
      if (command === 'acp_send_prompt') return 'end_turn'
      throw new Error(`unexpected invoke command: ${command}`)
    })
    await useAcpStore.getState().retryFailedLaunch(placeholderId)

    const state = useAcpStore.getState()
    // The real session replaced the placeholder (same tab, remapped id).
    expect(state.sessions[placeholderId]).toBeUndefined()
    expect(state.sessions['sess-retry']).toBeDefined()
    expect(state.sessions['sess-retry'].status).toBe('active')
    // The failed index entry is gone; the new session takes over the transcript.
    expect(state.sessionIndex.some((e) => e.id === placeholderId)).toBe(false)
    expect(state.messages[placeholderId]).toBeUndefined()
    expect(state.messages['sess-retry'].some((m) => m.role === 'user')).toBe(true)
    // The workspace tab was remapped onto the real session id.
    expect(workspaceStateRef.current.remapAgentChatSession).toHaveBeenCalledWith(
      placeholderId,
      'sess-retry'
    )
  })

  it('RETRY_SUCCESS with the tab closed mid-retry: no uninvited new tab is created', async () => {
    const placeholderId = await seedFailedLaunch(new Error('connection refused by agent'))
    // The user closed the chat tab while the retry was running: the adopt
    // guard must NOT fall through to remapAgentChatSession's no-pane fallback
    // (which would ADD a new tab the user never asked for).
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      tabs: [],
      activeTabId: null
    }
    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-retry', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return { sessionId: 'sess-retry-closed' }
      if (command === 'acp_send_prompt') return 'end_turn'
      throw new Error(`unexpected invoke command: ${command}`)
    })

    await useAcpStore.getState().retryFailedLaunch(placeholderId)

    // The session still lands active; only the tab adoption is skipped.
    expect(useAcpStore.getState().sessions['sess-retry-closed'].status).toBe('active')
    expect(workspaceStateRef.current.remapAgentChatSession).not.toHaveBeenCalled()
    expect(addAgentChatTabSpy).not.toHaveBeenCalled()
  })

  it('prompt-phase failure: the real session gets the raw error and no launchConfigId', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    const placeholderId = useAcpStore.getState().createLaunchPlaceholder({
      cwd: '/work',
      projectId: 'p1',
      initialUserBlocks: [{ type: 'text', text: 'hello agent' }]
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-1', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return { sessionId: 'sess-real' }
      if (command === 'acp_send_prompt') throw new Error('turn exploded')
      throw new Error(`unexpected invoke command: ${command}`)
    })
    await expect(
      useAcpStore.getState().finalizeChatLaunch({
        placeholderId,
        configId: 'cfg-1',
        cwd: '/work',
        projectId: 'p1',
        initialBlocks: [{ type: 'text', text: 'hello agent' }]
      })
    ).rejects.toThrow('turn exploded')

    const state = useAcpStore.getState()
    // The placeholder was merged away by startChat's success; the REAL session
    // carries the failure with the pre-existing raw stamping — and must NOT
    // become a retryable failed launch (its retry stays on the
    // retryCrashedSession reopen path so no orphan host session is created).
    expect(state.sessions[placeholderId]).toBeUndefined()
    const real = state.sessions['sess-real']
    expect(real.status).toBe('error')
    expect(real.lastError).toBe('turn exploded')
    expect(real.launchConfigId).toBeUndefined()
  })

  it('LAUNCH_FAIL: an ENOENT spawn failure carries command-specific guidance', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-npx', name: 'NPX Agent', command: 'npx', args: [], env: {} })
    const placeholderId = useAcpStore
      .getState()
      .createLaunchPlaceholder({ cwd: '/work', projectId: 'p1' })
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('spawn npx ENOENT'))
    await expect(
      useAcpStore.getState().finalizeChatLaunch({
        placeholderId,
        configId: 'cfg-npx',
        cwd: '/work',
        projectId: 'p1'
      })
    ).rejects.toThrow()
    expect(useAcpStore.getState().sessions[placeholderId].lastError).toMatch(/Install Node\.js/)
  })

  it('deleting an open failed session also closes its workspace tab', async () => {
    const placeholderId = await seedFailedLaunch(new Error('connection refused by agent'))
    await useAcpStore.getState().deleteHistorySession(placeholderId)
    expect(workspaceStateRef.current.removeTab).toHaveBeenCalledWith(`chat-${placeholderId}`)
    expect(useAcpStore.getState().sessionIndex.some((e) => e.id === placeholderId)).toBe(false)
    expect(useAcpStore.getState().sessions[placeholderId]?.status).toBe('closed')
  })

  it('RETRY_CANCELLED: deleting the failed chat mid-retry tears down the late session instead of merging/sending', async () => {
    const placeholderId = await seedFailedLaunch(new Error('connection refused by agent'))
    expect(useAcpStore.getState().sessionIndex.some((e) => e.id === placeholderId)).toBe(true)

    // Gate session/new so the retry parks inside startChat; the user deletes
    // the failed chat from history while the create is still in flight.
    let releaseCreate!: (value: { sessionId: string }) => void
    const createGate = new Promise<{ sessionId: string }>((resolve) => {
      releaseCreate = resolve
    })
    const sentPrompts: string[] = []
    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-retry', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return createGate
      if (command === 'acp_send_prompt') {
        sentPrompts.push(command)
        return 'end_turn'
      }
      if (command === 'acp_close_session') return undefined
      throw new Error(`unexpected invoke command: ${command}`)
    })

    const retry = useAcpStore.getState().retryFailedLaunch(placeholderId)
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('acp_new_session', expect.anything())
    )
    await useAcpStore.getState().deleteHistorySession(placeholderId)
    releaseCreate({ sessionId: 'sess-late' })
    // Cancellation is not a failure: the retry resolves cleanly.
    await expect(retry).resolves.toBeUndefined()

    const state = useAcpStore.getState()
    // The prompt was never sent and the deleted transcript never merged onto
    // the late session.
    expect(sentPrompts).toHaveLength(0)
    expect(state.messages['sess-late']).toBeUndefined()
    // The late session was closed + removed from history, not resurrected as
    // a ghost chat.
    expect(invoke).toHaveBeenCalledWith('acp_close_session', {
      agentId: 'agent-retry',
      sessionId: 'sess-late'
    })
    expect(state.sessions['sess-late']?.status).toBe('closed')
    expect(state.sessionIndex.some((e) => e.id === 'sess-late')).toBe(false)
    // The deleted chat stays deleted — no failed-row resurrection, no
    // lingering launch flag, no tab remap.
    expect(state.sessionIndex.some((e) => e.id === placeholderId)).toBe(false)
    expect(state.sessions[placeholderId]?.status).toBe('closed')
    expect(state.launchingSessionIds[placeholderId]).toBeUndefined()
    expect(workspaceStateRef.current.remapAgentChatSession).not.toHaveBeenCalled()
    expect(addAgentChatTabSpy).not.toHaveBeenCalled()
    // Boundary log records a cancellation, never a success.
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'acp.retryFailedLaunch.cancelled' })
    )
    expect(logFrontendError).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: 'acp.retryFailedLaunch.success' })
    )
  })

  it('RETRY_CANCELLED: a create failure after mid-retry deletion does not resurrect the deleted chat', async () => {
    const placeholderId = await seedFailedLaunch(new Error('connection refused by agent'))
    let rejectCreate!: (err: unknown) => void
    const createGate = new Promise<never>((_, reject) => {
      rejectCreate = reject
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-retry', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return createGate
      throw new Error(`unexpected invoke command: ${command}`)
    })

    const retry = useAcpStore.getState().retryFailedLaunch(placeholderId)
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('acp_new_session', expect.anything())
    )
    await useAcpStore.getState().deleteHistorySession(placeholderId)
    rejectCreate(new Error('spawn exploded again'))
    // Cancellation is not a failure: the retry resolves cleanly.
    await expect(retry).resolves.toBeUndefined()

    const state = useAcpStore.getState()
    // The deleted chat is NOT resurrected as a failed index entry: the user
    // discarded it, so the retry outcome lands only in the boundary log.
    expect(state.sessionIndex.some((e) => e.id === placeholderId)).toBe(false)
    expect(state.sessions[placeholderId]?.status).toBe('closed')
    expect(state.launchingSessionIds[placeholderId]).toBeUndefined()
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'acp.retryFailedLaunch.cancelled' })
    )
  })

  it('RETRY_FAIL_AUTH: a failing retry lands back in error and re-surfaces the actionable banner', async () => {
    const placeholderId = await seedFailedLaunch(new Error('connection refused by agent'))
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new AcpTransportError('agent_auth_required', 'sign-in required for this agent')
    )
    await expect(useAcpStore.getState().retryFailedLaunch(placeholderId)).rejects.toBeTruthy()

    const session = useAcpStore.getState().sessions[placeholderId]
    expect(session.status).toBe('error')
    expect(session.launchConfigId).toBe('cfg-1')
    expect(session.lastError).toContain('Authentication required')
    expect(session.lastError).toContain('sign-in required for this agent')
    // The placeholder keeps its id + transcript, and the index row persists.
    expect(useAcpStore.getState().sessionIndex.find((e) => e.id === placeholderId)?.status).toBe(
      'error'
    )
  })

  it('RETRY_NO_USER_MSG: a launch without a first prompt retries without re-sending', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    const placeholderId = useAcpStore
      .getState()
      .createLaunchPlaceholder({ cwd: '/work', projectId: 'p1' })
    ;(invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('spawn boom'))
    await expect(
      useAcpStore.getState().finalizeChatLaunch({
        placeholderId,
        configId: 'cfg-1',
        cwd: '/work',
        projectId: 'p1'
      })
    ).rejects.toBeTruthy()
    expect(useAcpStore.getState().sessions[placeholderId].status).toBe('error')

    const sent: string[] = []
    ;(invoke as ReturnType<typeof vi.fn>).mockImplementation(async (command: string) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-retry', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return { sessionId: 'sess-empty-retry' }
      if (command === 'acp_send_prompt') {
        sent.push(command)
        return 'end_turn'
      }
      throw new Error(`unexpected invoke command: ${command}`)
    })
    await useAcpStore.getState().retryFailedLaunch(placeholderId)

    expect(useAcpStore.getState().sessions['sess-empty-retry']).toBeDefined()
    // No user message existed, so no turn was re-sent.
    expect(sent).toHaveLength(0)
    expect(useAcpStore.getState().sessionIndex.some((e) => e.id === placeholderId)).toBe(false)
  })

  it('retryFailedLaunch rejects when no failed launch is recorded for the session', async () => {
    seedSession('s1', 'agent-1', false)
    await expect(useAcpStore.getState().retryFailedLaunch('s1')).rejects.toThrow(
      'no failed launch recorded'
    )
  })

  it('RELOAD_PRUNE: loadSessionIndex drops restored tabs matching neither live sessions nor the index', async () => {
    // A live session (failed launch still in memory) keeps its tab; a corpse
    // tab whose session is neither live nor indexed is closed.
    seedSession('s-live', 'agent-1', false)
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-s-live',
      tabs: [
        { type: 'agent-chat', id: 'chat-s-live', sessionId: 's-live' },
        { type: 'agent-chat', id: 'chat-s-corpse', sessionId: 's-corpse' },
        { type: 'agent-chat', id: 'chat-s-indexed', sessionId: 's-indexed' }
      ]
    }
    vi.mocked(loadSessionIndex).mockResolvedValueOnce([
      {
        id: 's-indexed',
        agentId: 'agent-1',
        title: 'Persisted chat',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 2,
        messageCount: 1,
        status: 'closed'
      }
    ])

    await useAcpStore.getState().loadSessionIndex()

    expect(workspaceStateRef.current.removeTab).toHaveBeenCalledTimes(1)
    expect(workspaceStateRef.current.removeTab).toHaveBeenCalledWith('chat-s-corpse')
  })

  it('RELOAD_PRUNE: a failed index load preserves every tab', async () => {
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: null,
      tabs: [{ type: 'agent-chat', id: 'chat-s-corpse', sessionId: 's-corpse' }]
    }
    vi.mocked(loadSessionIndex).mockRejectedValueOnce(new Error('disk gone'))

    await expect(useAcpStore.getState().loadSessionIndex()).rejects.toThrow('disk gone')
    expect(workspaceStateRef.current.removeTab).not.toHaveBeenCalled()
  })

  it('RELOAD_RECOVER: a dropped launch placeholder opens the only active persisted session', async () => {
    useProjectStore.setState({ activeProjectId: 'p1' })
    noteDroppedLaunchPlaceholders('p1', ['launch-abc'])
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: null,
      tabs: []
    }
    vi.mocked(loadSessionIndex).mockResolvedValueOnce([
      {
        id: 's-live',
        agentId: 'agent-1',
        title: 'Live chat',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 5,
        messageCount: 2,
        status: 'active'
      },
      {
        id: 's-old',
        agentId: 'agent-1',
        title: 'Closed chat',
        cwd: '/work',
        projectId: 'p1',
        createdAt: 1,
        lastActivityAt: 9,
        messageCount: 1,
        status: 'closed'
      }
    ])

    await useAcpStore.getState().loadSessionIndex()

    expect(addAgentChatTabSpy).toHaveBeenCalledTimes(1)
    expect(addAgentChatTabSpy).toHaveBeenCalledWith('s-live')
    expect(addAgentChatTabSpy).not.toHaveBeenCalledWith('launch-abc')
  })

  function persisted(id: string, projectId: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      agentId: 'agent-1',
      title: id,
      cwd: '/work',
      projectId,
      createdAt: 1,
      lastActivityAt: 5,
      messageCount: 1,
      status: 'active' as const,
      ...extra
    }
  }

  it('RELOAD_RECOVER: an index row with turnActive wins among several active chats', async () => {
    useProjectStore.setState({ activeProjectId: 'p1' })
    noteDroppedLaunchPlaceholders('p1', ['launch-abc'])
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: null,
      tabs: []
    }
    vi.mocked(loadSessionIndex).mockResolvedValueOnce([
      persisted('s-idle', 'p1', { lastActivityAt: 50 }),
      persisted('s-turn', 'p1', { turnActive: true, lastActivityAt: 10 })
    ])

    await useAcpStore.getState().loadSessionIndex()

    expect(addAgentChatTabSpy).toHaveBeenCalledTimes(1)
    expect(addAgentChatTabSpy).toHaveBeenCalledWith('s-turn')
  })

  it('RELOAD_RECOVER: several active chats with no live turn are left closed', async () => {
    useProjectStore.setState({ activeProjectId: 'p1' })
    noteDroppedLaunchPlaceholders('p1', ['launch-abc'])
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: null,
      tabs: []
    }
    vi.mocked(loadSessionIndex).mockResolvedValueOnce([
      persisted('s-a', 'p1', { lastActivityAt: 2 }),
      persisted('s-b', 'p1', { lastActivityAt: 9 })
    ])

    await useAcpStore.getState().loadSessionIndex()

    expect(addAgentChatTabSpy).not.toHaveBeenCalled()
  })

  it('RELOAD_RECOVER: derives turnActive from the payload when the index omits it', async () => {
    useProjectStore.setState({ activeProjectId: 'p1' })
    noteDroppedLaunchPlaceholders('p1', ['launch-abc'])
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: null,
      tabs: []
    }
    setCachedSessionPayload('s-live', {
      metadata: persisted('s-live', 'p1', { turnActive: true }),
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
    })
    vi.mocked(loadSessionIndex).mockResolvedValueOnce([
      persisted('s-idle', 'p1', { lastActivityAt: 40 }),
      persisted('s-live', 'p1', { lastActivityAt: 4 })
    ])

    await useAcpStore.getState().loadSessionIndex()

    expect(addAgentChatTabSpy).toHaveBeenCalledTimes(1)
    expect(addAgentChatTabSpy).toHaveBeenCalledWith('s-live')
  })

  it('RELOAD_RECOVER: placeholders noted after the index load still reopen the chat', async () => {
    useProjectStore.setState({ activeProjectId: 'p1' })
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: null,
      tabs: []
    }
    vi.mocked(loadSessionIndex).mockResolvedValueOnce([persisted('s-live', 'p1')])

    await useAcpStore.getState().loadSessionIndex()
    expect(addAgentChatTabSpy).not.toHaveBeenCalled()

    noteDroppedLaunchPlaceholders('p1', ['launch-abc'])
    await vi.waitFor(() => {
      expect(addAgentChatTabSpy).toHaveBeenCalledWith('s-live')
    })
  })

  it('RELOAD_RECOVER: does not open another project’s chat into the active workspace', async () => {
    useProjectStore.setState({ activeProjectId: 'p1' })
    noteDroppedLaunchPlaceholders('p1', ['launch-a'])
    noteDroppedLaunchPlaceholders('p2', ['launch-b'])
    workspaceStateRef.current.root = {
      type: 'leaf',
      id: 'pane-1',
      activeTabId: null,
      tabs: []
    }
    vi.mocked(loadSessionIndex).mockResolvedValueOnce([
      persisted('s-p1', 'p1'),
      persisted('s-p2', 'p2', { lastActivityAt: 99 })
    ])

    await useAcpStore.getState().loadSessionIndex()

    expect(addAgentChatTabSpy).toHaveBeenCalledTimes(1)
    expect(addAgentChatTabSpy).toHaveBeenCalledWith('s-p1')
    expect(addAgentChatTabSpy).not.toHaveBeenCalledWith('s-p2')
    expect(takeAllDroppedLaunchPlaceholders()).toEqual([{ projectId: 'p2', count: 1 }])
  })
})
