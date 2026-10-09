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
import { _resetAcpTransportForTests } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import {
  _addEphemeralSessionIdForTesting,
  _resetAcpAuthForTesting,
  _resetCoalesceForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetHistorySeqWatermarksForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetInFlightPreparedForTesting,
  _resetLiveSwitchSourcesForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  agentReuseKey,
  useAcpStore
} from '@/stores/acp-store'
import {
  FRESH,
  makeConfigOption,
  makeMode,
  makeModel,
  seedOptionsSession,
  seedSession
} from './testkit'

describe('acp-store: composer-selection persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(invoke as ReturnType<typeof vi.fn>).mockReset()
    mockPersistenceApi.read.mockReset()
    mockPersistenceApi.writeDebounced.mockReset()
    mockPersistenceApi.read.mockResolvedValue({ success: false })
    mockPersistenceApi.writeDebounced.mockResolvedValue({ success: true })
    _resetAcpTransportForTests(null)
    _resetInFlightHistoryOpensForTesting()
    _resetAcpAuthForTesting()
    _resetInFlightPreparedForTesting()
    _resetCoalesceForTesting()
    _resetEphemeralSessionIdsForTesting()
    _resetSessionIndexLoadGenerationForTesting()
    _resetHistorySeqWatermarksForTesting()
    _resetLiveSwitchSourcesForTesting()
    useAcpStore.setState(FRESH)
  })

  it('setModel persists the modelId to persistenceApi (debounced)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    seedSession('sess-persist', 'agent-9', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'sess-persist': {
          ...s.sessions['sess-persist'],
          models: {
            currentModelId: 'm1',
            availableModels: [
              { modelId: 'm1', name: 'Model One' },
              { modelId: 'm2', name: 'Model Two' }
            ]
          }
        }
      },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined) // set_model

    await useAcpStore.getState().setModel('sess-persist', 'm2')
    // persistComposerOptions chains on a per-key promise queue; flush the
    // microtask before asserting.
    await vi.waitFor(() => expect(mockPersistenceApi.writeDebounced).toHaveBeenCalled())

    expect(mockPersistenceApi.writeDebounced).toHaveBeenCalledWith(
      'agents/composer-options/cfg-1',
      expect.objectContaining({ modelId: 'm2' })
    )
  })

  it('setMode persists the modeId to persistenceApi (debounced)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    seedSession('sess-persist', 'agent-9', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'sess-persist': {
          ...s.sessions['sess-persist'],
          modes: {
            currentModeId: 'agent',
            availableModes: [
              { id: 'agent', name: 'Agent' },
              { id: 'plan', name: 'Plan' }
            ]
          }
        }
      },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined) // set_mode

    await useAcpStore.getState().setMode('sess-persist', 'plan')
    await vi.waitFor(() => expect(mockPersistenceApi.writeDebounced).toHaveBeenCalled())

    expect(mockPersistenceApi.writeDebounced).toHaveBeenCalledWith(
      'agents/composer-options/cfg-1',
      expect.objectContaining({ modeId: 'plan' })
    )
  })

  it('setConfigOption persists the config value to persistenceApi (debounced)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    seedSession('sess-persist', 'agent-9', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'sess-persist': {
          ...s.sessions['sess-persist'],
          configOptions: [
            {
              id: 'thought_level',
              name: 'Thinking',
              category: 'thought_level',
              type: 'select',
              currentValue: 'low',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'high', name: 'High' }
              ]
            }
          ]
        }
      },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: 'thought_level',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' }
        ]
      }
    ]) // set_config_option

    await useAcpStore.getState().setConfigOption('sess-persist', 'thought_level', 'high')
    await vi.waitFor(() => expect(mockPersistenceApi.writeDebounced).toHaveBeenCalled())

    expect(mockPersistenceApi.writeDebounced).toHaveBeenCalledWith(
      'agents/composer-options/cfg-1',
      expect.objectContaining({ configValues: { thought_level: 'high' } })
    )
  })

  it('keeps the user-picked model when a set_config_option snapshot reports a desynced model value', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Droid', command: 'droid', args: [], env: {} })
    seedSession('sess-drift', 'agent-9', false)
    const reasoningOption = {
      id: 'reasoning',
      name: 'Reasoning',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' }
      ]
    }
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'sess-drift': {
          ...s.sessions['sess-drift'],
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'gpt-6-luna',
              options: [
                { value: 'gpt-6-luna', name: 'GPT 6 Luna' },
                { value: 'kimi-k3', name: 'Kimi K3' }
              ]
            },
            reasoningOption
          ]
        }
      },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    // The user changes REASONING; the snapshot response reports the model as
    // kimi-k3 (agent-backend desync — QA: the picker flipped to Kimi K3 while
    // the agent kept answering with the user's model).
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'kimi-k3',
        options: [
          { value: 'gpt-6-luna', name: 'GPT 6 Luna' },
          { value: 'kimi-k3', name: 'Kimi K3' }
        ]
      },
      { ...reasoningOption, currentValue: 'high' }
    ])

    await useAcpStore.getState().setConfigOption('sess-drift', 'reasoning', 'high')

    const options = useAcpStore.getState().sessions['sess-drift'].configOptions
    expect(options.find((o) => o.id === 'model')?.currentValue).toBe('gpt-6-luna')
    expect(options.find((o) => o.id === 'reasoning')?.currentValue).toBe('high')
  })

  it('keeps the user-picked model on a config_option_update push, but yields when the value is dropped from the list', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Droid', command: 'droid', args: [], env: {} })
    seedSession('sess-drift', 'agent-9', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'sess-drift': {
          ...s.sessions['sess-drift'],
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'gpt-6-luna',
              options: [
                { value: 'gpt-6-luna', name: 'GPT 6 Luna' },
                { value: 'kimi-k3', name: 'Kimi K3' }
              ]
            }
          ]
        }
      }
    }))

    // Contradictory push: the model value the user picked is still listed —
    // the agent's desynced currentValue must not clobber it.
    useAcpStore.getState()._onConfigOptionsUpdate({
      sessionId: 'sess-drift',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'kimi-k3',
          options: [
            { value: 'gpt-6-luna', name: 'GPT 6 Luna' },
            { value: 'kimi-k3', name: 'Kimi K3' }
          ]
        }
      ]
    })
    expect(
      useAcpStore.getState().sessions['sess-drift'].configOptions.find((o) => o.id === 'model')
        ?.currentValue
    ).toBe('gpt-6-luna')

    // Genuine change: the user's pick is GONE from the advertised list (e.g.
    // the model was retired) — the agent's value legitimately applies.
    useAcpStore.getState()._onConfigOptionsUpdate({
      sessionId: 'sess-drift',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'kimi-k3',
          options: [{ value: 'kimi-k3', name: 'Kimi K3' }]
        }
      ]
    })
    expect(
      useAcpStore.getState().sessions['sess-drift'].configOptions.find((o) => o.id === 'model')
        ?.currentValue
    ).toBe('kimi-k3')
  })

  it('persistComposerOptions merges partial patches (does not overwrite existing fields)', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    seedSession('sess-persist', 'agent-9', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'sess-persist': {
          ...s.sessions['sess-persist'],
          models: {
            currentModelId: 'm1',
            availableModels: [
              { modelId: 'm1', name: 'Model One' },
              { modelId: 'm2', name: 'Model Two' }
            ]
          },
          modes: {
            currentModeId: 'agent',
            availableModes: [
              { id: 'agent', name: 'Agent' },
              { id: 'plan', name: 'Plan' }
            ]
          }
        }
      },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    // Simulate an existing persisted record with a config value.
    mockPersistenceApi.read.mockResolvedValue({
      success: true,
      data: { configValues: { thought_level: 'high' } }
    })
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined) // set_model

    await useAcpStore.getState().setModel('sess-persist', 'm2')
    // The model list is saved under its own key; only the composer-options
    // write is under test here.
    const composerWrites = () =>
      vi
        .mocked(mockPersistenceApi.writeDebounced)
        .mock.calls.filter((c) => String(c[0]).startsWith('agents/composer-options/'))
    await vi.waitFor(() => expect(composerWrites().length).toBeGreaterThan(0))

    const callArgs = composerWrites()[0]
    expect(callArgs).toBeDefined()
    const written = callArgs![1] as Record<string, unknown>
    // The merge preserves the existing configValues while adding modelId.
    expect(written).toMatchObject({
      modelId: 'm2',
      configValues: { thought_level: 'high' }
    })
  })

  it('skips persistence for ephemeral/warm-pool sessions', async () => {
    await useAcpStore
      .getState()
      .saveAgentConfig({ id: 'cfg-1', name: 'Gemini', command: 'gemini', args: [], env: {} })
    seedSession('sess-eph', 'agent-9', false)
    useAcpStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        'sess-eph': {
          ...s.sessions['sess-eph'],
          models: {
            currentModelId: 'm1',
            availableModels: [
              { modelId: 'm1', name: 'Model One' },
              { modelId: 'm2', name: 'Model Two' }
            ]
          }
        }
      },
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey('cfg-1', '/work')]: 'agent-9' }
    }))
    // Mark the session as ephemeral (warm-pool seed).
    _addEphemeralSessionIdForTesting('sess-eph')
    ;(invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined) // set_model

    await useAcpStore.getState().setModel('sess-eph', 'm2')
    // Ephemeral sessions skip composer-option persistence so agent defaults
    // don't overwrite the user's real last selection. (The config's model
    // list may still be saved: it is per config, not a selection.)
    const composerWrites = vi
      .mocked(mockPersistenceApi.writeDebounced)
      .mock.calls.filter((c) => String(c[0]).startsWith('agents/composer-options/'))
    expect(composerWrites).toHaveLength(0)
  })
})

// --- spec-acp-composer-option-fidelity: launcher/switch option integrity ---

describe('composer option fidelity', () => {
  const invokeCallsFor = (command: string) =>
    vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === command)
      .map((c) => c[1] as Record<string, unknown>)

  beforeEach(() => {
    vi.clearAllMocks()
    ;(invoke as ReturnType<typeof vi.fn>).mockReset()
    mockPersistenceApi.read.mockReset()
    mockPersistenceApi.write.mockReset()
    mockPersistenceApi.writeDebounced.mockReset()
    mockPersistenceApi.delete.mockReset()
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
    useAcpStore.setState(FRESH)
    workspaceStateRef.current = {
      root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
      removeTab: vi.fn(),
      remapAgentChatSession: vi.fn()
    }
  })

  describe('applyPendingLauncherOptions', () => {
    it('skips every wire call when the requested values are already current', async () => {
      seedOptionsSession('s1', 'agent-1', {
        modes: { currentModeId: 'plan', availableModes: [makeMode('agent'), makeMode('plan')] },
        models: { currentModelId: 'm2', availableModels: [makeModel('m1'), makeModel('m2')] },
        configOptions: [makeConfigOption('thought_level', 'max', ['low', 'max'])]
      })

      await useAcpStore.getState().applyPendingLauncherOptions('s1', {
        modelId: 'm2',
        modeId: 'plan',
        configValues: { thought_level: 'max' }
      })

      for (const command of ['acp_set_mode', 'acp_set_model', 'acp_set_config_option']) {
        expect(invokeCallsFor(command)).toEqual([])
      }
      expect(toastError).not.toHaveBeenCalled()
    })

    it('isolates per-option failures: one rejected pick does not abort the rest', async () => {
      seedOptionsSession('s1', 'agent-1', {
        modes: { currentModeId: 'agent', availableModes: [makeMode('agent'), makeMode('plan')] },
        configOptions: [
          makeConfigOption('opt-a', 'a1', ['a1', 'a2']),
          makeConfigOption('opt-b', 'b1', ['b1', 'b2'])
        ]
      })
      vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
        if (command === 'acp_set_mode') throw new Error('mode rejected')
        if (command === 'acp_set_config_option') {
          const { configId } = args as { configId: string }
          if (configId === 'opt-a') throw new Error('opt-a rejected')
          return [
            makeConfigOption('opt-a', 'a1', ['a1', 'a2']),
            makeConfigOption('opt-b', 'b2', ['b1', 'b2'])
          ]
        }
        throw new Error(`unexpected invoke command: ${command}`)
      })

      await useAcpStore.getState().applyPendingLauncherOptions('s1', {
        modeId: 'plan',
        configValues: { 'opt-a': 'a2', 'opt-b': 'b2' }
      })

      // opt-b still applied despite the mode + opt-a failures.
      const configCalls = invokeCallsFor('acp_set_config_option')
      expect(configCalls.map((c) => c.configId)).toEqual(['opt-a', 'opt-b'])
      const session = useAcpStore.getState().sessions['s1']
      expect(session.configOptions.find((o) => o.id === 'opt-b')?.currentValue).toBe('b2')
      // Each failed option produced a warn log; the launch does not fail.
      const warns = vi
        .mocked(logFrontendError)
        .mock.calls.map((c) => c[0])
        .filter((l) => l.source === 'acp.applyPendingLauncherOptions')
      expect(warns.length).toBeGreaterThanOrEqual(2)
    })

    it('sends a stored boolean option as a boolean', async () => {
      seedOptionsSession('s1', 'agent-1', {
        configOptions: [
          {
            id: 'approvals',
            name: 'Approvals',
            category: null,
            type: 'boolean',
            currentValue: false
          }
        ]
      })
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        if (command === 'acp_set_config_option') {
          return [
            {
              id: 'approvals',
              name: 'Approvals',
              category: null,
              type: 'boolean',
              currentValue: true
            }
          ]
        }
        throw new Error(`unexpected invoke command: ${command}`)
      })

      await useAcpStore.getState().applyPendingLauncherOptions('s1', {
        configValues: { approvals: 'true' }
      })

      expect(invokeCallsFor('acp_set_config_option')).toEqual([
        expect.objectContaining({ configId: 'approvals', valueId: true })
      ])
    })

    it('toasts only when no model application path exists', async () => {
      // No native models state AND no model-category config option.
      seedOptionsSession('s1', 'agent-1')
      await useAcpStore.getState().applyPendingLauncherOptions('s1', {
        modelId: 'm-missing',
        configValues: {}
      })
      expect(toastError).toHaveBeenCalledWith(
        'Selected model is not available in this session',
        expect.objectContaining({ description: expect.stringContaining('m-missing') })
      )

      // A model-category config option receives the fallback write (no toast).
      vi.clearAllMocks()
      seedOptionsSession('s1', 'agent-1', {
        configOptions: [makeConfigOption('model', 'm1', ['m1', 'm2'], 'model')]
      })
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        if (command === 'acp_set_config_option')
          return [makeConfigOption('model', 'm2', ['m1', 'm2'], 'model')]
        throw new Error(`unexpected invoke command: ${command}`)
      })
      await useAcpStore.getState().applyPendingLauncherOptions('s1', {
        modelId: 'm2',
        configValues: {}
      })
      expect(toastError).not.toHaveBeenCalled()
      expect(invokeCallsFor('acp_set_config_option')).toEqual([
        expect.objectContaining({ sessionId: 's1', configId: 'model', valueId: 'm2' })
      ])
    })
  })
})
