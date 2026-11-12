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
    saveMcpServers: vi.fn(async () => {})
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
  latestModelPick,
  persistComposerOptions,
  readComposerOptions,
  reopenRestores
} from './composer-options'
import { prepareChatKey, reapplyPersistedComposerOptions } from './helpers'
import { dropSessionBookkeeping } from './slices/transcript'
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
    // persistComposerOptions chains on a per-key promise queue.
    await vi.waitFor(() =>
      expect(mockPersistenceApi.writeDebounced).toHaveBeenCalledWith(
        'agents/composer-options/cfg-1',
        expect.objectContaining({ modelId: 'm2' })
      )
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

  describe('sidebar model projection', () => {
    const modelOption = (current: 'haiku' | 'sonnet') => ({
      id: 'model',
      name: 'Model',
      category: 'model' as const,
      type: 'select',
      currentValue: current,
      options: [
        { value: 'haiku', name: 'Haiku 5.5' },
        { value: 'sonnet', name: 'Sonnet 5.5' }
      ]
    })

    const indexRow = (modelId: string, modelName: string) => ({
      id: 's1',
      agentId: 'agent-1',
      title: 'Chat',
      cwd: '/work',
      projectId: 'p1',
      createdAt: 1,
      lastActivityAt: 1,
      messageCount: 1,
      status: 'active' as const,
      modelId,
      modelName
    })

    it('setConfigOption records the selected model on the session and the chat index', async () => {
      seedOptionsSession('s1', 'agent-1', {
        models: {
          currentModelId: 'haiku',
          availableModels: [
            { modelId: 'haiku', name: 'Haiku 5.5' },
            { modelId: 'sonnet', name: 'Sonnet 5.5' }
          ]
        },
        configOptions: [modelOption('haiku')]
      })
      useAcpStore.setState({ sessionIndex: [indexRow('haiku', 'Haiku 5.5')] })
      vi.mocked(invoke).mockImplementation(async (command: string) => {
        if (command === 'acp_set_config_option') return [modelOption('sonnet')]
        throw new Error(`unexpected invoke command: ${command}`)
      })

      await useAcpStore.getState().setConfigOption('s1', 'model', 'sonnet')

      const state = useAcpStore.getState()
      expect(state.sessions.s1.models?.currentModelId).toBe('sonnet')
      expect(
        state.sessions.s1.configOptions.find((option) => option.id === 'model')?.currentValue
      ).toBe('sonnet')
      expect(state.sessionIndex.find((entry) => entry.id === 's1')).toEqual(
        expect.objectContaining({ modelId: 'sonnet', modelName: 'Sonnet 5.5' })
      )
    })

    it('keeps the selected model when a config update echoes the creation model', () => {
      seedOptionsSession('s1', 'agent-1', {
        models: {
          currentModelId: 'sonnet',
          availableModels: [
            { modelId: 'haiku', name: 'Haiku 5.5' },
            { modelId: 'sonnet', name: 'Sonnet 5.5' }
          ]
        },
        configOptions: [modelOption('sonnet')],
        creationOptionDefaults: { configValues: { model: 'haiku' } }
      })
      useAcpStore.setState({ sessionIndex: [indexRow('sonnet', 'Sonnet 5.5')] })

      useAcpStore.getState()._onConfigOptionsUpdate({
        agentId: 'agent-1',
        sessionId: 's1',
        configOptions: [modelOption('haiku')]
      })

      const state = useAcpStore.getState()
      expect(state.sessions.s1.configOptions[0]?.currentValue).toBe('sonnet')
      expect(state.sessions.s1.models?.currentModelId).toBe('sonnet')
      expect(state.sessionIndex.find((entry) => entry.id === 's1')?.modelName).toBe('Sonnet 5.5')
    })

    it('persistSession writes the live model and keeps a host name when the session has none', () => {
      seedOptionsSession('s1', 'agent-1', {
        models: {
          currentModelId: 'haiku',
          availableModels: [{ modelId: 'haiku', name: 'Haiku 5.5' }]
        },
        configOptions: [modelOption('sonnet')]
      })
      seedOptionsSession('s-keep', 'agent-1')
      useAcpStore.setState({
        sessionIndex: [
          indexRow('haiku', 'Haiku 5.5'),
          { ...indexRow('opus', 'Opus'), id: 's-keep' }
        ],
        messages: {
          s1: [
            {
              id: 'm1',
              role: 'user',
              blocks: [{ type: 'text', text: 'hi' }],
              streaming: false,
              timestamp: 1
            }
          ],
          's-keep': [
            {
              id: 'm2',
              role: 'user',
              blocks: [{ type: 'text', text: 'hi' }],
              streaming: false,
              timestamp: 1
            }
          ]
        }
      })

      useAcpStore.getState()._onSessionInfoUpdate({
        agentId: 'agent-1',
        sessionId: 's1',
        title: 'Named'
      })
      useAcpStore.getState()._onSessionInfoUpdate({
        agentId: 'agent-1',
        sessionId: 's-keep',
        title: 'Kept'
      })

      const state = useAcpStore.getState()
      expect(state.sessionIndex.find((entry) => entry.id === 's1')).toEqual(
        expect.objectContaining({ title: 'Named', modelId: 'sonnet', modelName: 'Sonnet 5.5' })
      )
      expect(state.sessionIndex.find((entry) => entry.id === 's-keep')).toEqual(
        expect.objectContaining({ title: 'Kept', modelId: 'opus', modelName: 'Opus' })
      )
    })
  })
})

describe('per-model option values (spec-model-options-persist-with-model)', () => {
  const CONFIG = 'cfg-1'
  const RECORD_KEY = `agents/composer-options/${CONFIG}`
  /** The agent's effort choices per model; a model switch resets effort to `medium`. */
  const EFFORTS: Record<string, string[]> = {
    opus: ['low', 'medium', 'high'],
    sonnet: ['low', 'medium']
  }
  const modelOption = (current: string) =>
    makeConfigOption('model', current, ['opus', 'sonnet', 'haiku'], 'model')
  const effortOption = (model: string, current: string) =>
    makeConfigOption('effort', current, EFFORTS[model] ?? ['medium'], 'thought_level')
  /** Claude-style permission mode: a `mode`-category config option. */
  const permissionOption = (current: string) =>
    makeConfigOption('permission', current, ['default', 'bypass'], 'mode')

  let stored: Record<string, unknown>
  let wire: string[]
  let agent: { model: string; effort: string; permission: string }
  const advertised = () => [
    modelOption(agent.model),
    effortOption(agent.model, agent.effort),
    permissionOption(agent.permission)
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    ;(invoke as ReturnType<typeof vi.fn>).mockReset()
    _resetAcpTransportForTests(null)
    _resetEphemeralSessionIdsForTesting()
    useAcpStore.setState(FRESH)
    stored = {}
    wire = []
    mockPersistenceApi.read.mockReset()
    mockPersistenceApi.writeDebounced.mockReset()
    mockPersistenceApi.read.mockImplementation(async (key: string) =>
      key in stored ? { success: true, data: stored[key] } : { success: false }
    )
    mockPersistenceApi.writeDebounced.mockImplementation(async (key: string, data: unknown) => {
      stored[key] = data
      return { success: true }
    })
    agent = { model: 'opus', effort: 'high', permission: 'default' }
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      if (command !== 'acp_set_config_option') throw new Error(`unexpected ${command}`)
      const { configId, valueId } = args as { configId: string; valueId: string }
      wire.push(`${configId}=${valueId}`)
      if (configId === 'model') {
        agent.model = valueId
        agent.effort = 'medium'
      } else if (configId === 'permission') {
        agent.permission = valueId
      } else {
        agent.effort = valueId
      }
      return advertised()
    })
  })

  function seedChat(id: string, model: string, effort: string, permission = 'default'): void {
    agent = { model, effort, permission }
    seedOptionsSession(id, 'agent-1', { configOptions: advertised() })
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey(CONFIG, '/work')]: 'agent-1' }
    }))
  }

  const currentOf = (id: string, optionId: string) =>
    useAcpStore.getState().sessions[id].configOptions.find((o) => o.id === optionId)?.currentValue
  const effortOf = (id: string) => currentOf(id, 'effort')

  const warnsFrom = (source: string) =>
    vi
      .mocked(logFrontendError)
      .mock.calls.map(([entry]) => entry)
      .filter((entry) => entry.source === source && entry.level === 'warn')
      .map((entry) => entry.message)

  /** Let queued record writes land. */
  const settleWrites = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  it('an effort change is saved under the model the chat runs', async () => {
    seedChat('s1', 'opus', 'high')

    await useAcpStore.getState().setConfigOption('s1', 'effort', 'low')
    await vi.waitFor(() => expect(stored[RECORD_KEY]).toBeDefined())

    expect(stored[RECORD_KEY]).toEqual({
      configValues: { effort: 'low' },
      modelValues: { opus: { effort: 'low' } }
    })
  })

  it("an effort change keeps the other models' saved values", async () => {
    seedChat('s1', 'opus', 'high')
    stored[RECORD_KEY] = {
      modelId: 'opus',
      modelValues: { sonnet: { effort: 'low' }, opus: { effort: 'high', fast: 'true' } }
    }

    await useAcpStore.getState().setConfigOption('s1', 'effort', 'medium')
    await settleWrites()

    expect(stored[RECORD_KEY]).toEqual({
      modelId: 'opus',
      configValues: { effort: 'medium' },
      modelValues: { sonnet: { effort: 'low' }, opus: { effort: 'medium', fast: 'true' } }
    })
  })

  it('permission mode stays agent-wide: never saved per model', async () => {
    seedChat('s1', 'opus', 'high')

    await useAcpStore.getState().setConfigOption('s1', 'permission', 'bypass')
    await settleWrites()

    expect(stored[RECORD_KEY]).toEqual({ configValues: { permission: 'bypass' } })
  })

  it('picking a model brings back the effort saved for that model, never the mode', async () => {
    seedChat('s1', 'opus', 'high')
    stored[RECORD_KEY] = {
      modelId: 'opus',
      configValues: { permission: 'bypass' },
      modelValues: { opus: { effort: 'high' }, sonnet: { effort: 'low' } }
    }

    await useAcpStore.getState().pickModel('s1', 'sonnet')

    expect(wire).toEqual(['model=sonnet', 'effort=low'])
    expect(effortOf('s1')).toBe('low')
    expect(currentOf('s1', 'permission')).toBe('default')
  })

  it('a model never tuned keeps the agent default', async () => {
    seedChat('s1', 'opus', 'high')
    stored[RECORD_KEY] = { modelId: 'opus', modelValues: { opus: { effort: 'high' } } }

    await useAcpStore.getState().pickModel('s1', 'sonnet')

    expect(wire).toEqual(['model=sonnet'])
    expect(effortOf('s1')).toBe('medium')
  })

  it('switching away and back restores the effort set on the first model', async () => {
    seedChat('s1', 'opus', 'high')

    await useAcpStore.getState().setConfigOption('s1', 'effort', 'low')
    await useAcpStore.getState().pickModel('s1', 'sonnet')
    await useAcpStore.getState().pickModel('s1', 'opus')

    expect(wire).toEqual(['effort=low', 'model=sonnet', 'model=opus', 'effort=low'])
    expect(effortOf('s1')).toBe('low')
    await settleWrites()
    expect(stored[RECORD_KEY]).toEqual({
      modelId: 'opus',
      configValues: { model: 'opus', effort: 'low' },
      modelValues: { opus: { effort: 'low' } }
    })
  })

  it('a newer model pick wins over one still reading the saved record', async () => {
    seedChat('s1', 'haiku', 'medium')
    stored[RECORD_KEY] = {
      modelId: 'haiku',
      modelValues: { opus: { effort: 'high' }, sonnet: { effort: 'low' } }
    }

    await Promise.all([
      useAcpStore.getState().pickModel('s1', 'sonnet'),
      useAcpStore.getState().pickModel('s1', 'opus')
    ])

    expect(wire).toEqual(['model=opus', 'effort=high'])
  })

  it('a favorite snapshot applies after its model; a value the model does not offer is skipped with a warn', async () => {
    seedChat('s1', 'opus', 'low')

    await useAcpStore.getState().pickModel('s1', 'sonnet', { effort: 'high' })

    expect(wire).toEqual(['model=sonnet'])
    expect(effortOf('s1')).toBe('medium')
    expect(warnsFrom('acp.pickModel')).toEqual([
      "skipped saved value for 'effort' on session s1: the session does not advertise it"
    ])
  })

  it('a favorite of the current model applies only its snapshot', async () => {
    seedChat('s1', 'opus', 'low')

    await useAcpStore.getState().pickModel('s1', 'opus', { effort: 'high' })

    expect(wire).toEqual(['effort=high'])
  })

  it('a native model switch waits for the new effort choices before applying values', async () => {
    const effortsBy: Record<string, string[]> = { opus: ['low', 'high'], sonnet: ['low'] }
    const nativeEffort = (model: string, current: string) =>
      makeConfigOption('effort', current, effortsBy[model] ?? [], 'thought_level')
    seedOptionsSession('s1', 'agent-1', {
      models: {
        currentModelId: 'sonnet',
        availableModels: [
          { modelId: 'opus', name: 'Opus' },
          { modelId: 'sonnet', name: 'Sonnet' }
        ]
      },
      configOptions: [nativeEffort('sonnet', 'low')]
    })
    useAcpStore.setState((s) => ({
      configToLiveAgent: { ...s.configToLiveAgent, [agentReuseKey(CONFIG, '/work')]: 'agent-1' }
    }))
    stored[RECORD_KEY] = { modelId: 'sonnet', modelValues: { opus: { effort: 'high' } } }
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      const { modelId, configId, valueId } = args as Record<string, string>
      if (command === 'acp_set_model') {
        wire.push(`model=${modelId}`)
        // The agent re-advertises effort for the new model a moment later.
        setTimeout(() => {
          useAcpStore.setState((s) => ({
            sessions: {
              ...s.sessions,
              s1: { ...s.sessions.s1, configOptions: [nativeEffort(modelId, 'low')] }
            }
          }))
        }, 30)
        return null
      }
      wire.push(`${configId}=${valueId}`)
      return [nativeEffort('opus', valueId)]
    })

    await useAcpStore.getState().pickModel('s1', 'opus')

    expect(wire).toEqual(['model=opus', 'effort=high'])
    expect(effortOf('s1')).toBe('high')
  })

  it('live reapply sets the saved model first, then that model’s values and the agent-wide mode', async () => {
    seedChat('s1', 'sonnet', 'medium')
    const record = {
      modelId: 'opus',
      configValues: { model: 'opus', effort: 'high', permission: 'bypass' },
      modelValues: { opus: { effort: 'high' } }
    }
    stored[RECORD_KEY] = record

    await reapplyPersistedComposerOptions(useAcpStore.getState as never, 's1', CONFIG)
    await settleWrites()

    expect(wire).toEqual(['model=opus', 'permission=bypass', 'effort=high'])
    expect(effortOf('s1')).toBe('high')
    // A restore, not a pick: the saved record is left as it was.
    expect(stored[RECORD_KEY]).toBe(record)
  })

  it('live reapply restores the saved model, not a stale model entry in the flat values', async () => {
    seedChat('s1', 'sonnet', 'medium')
    stored[RECORD_KEY] = {
      modelId: 'opus',
      configValues: { model: 'haiku' },
      modelValues: { opus: { effort: 'high' } }
    }

    await reapplyPersistedComposerOptions(useAcpStore.getState as never, 's1', CONFIG)

    expect(wire).toEqual(['model=opus', 'effort=high'])
  })

  it('live reapply skips a saved model the agent no longer offers, and its values, but heals the mode', async () => {
    seedChat('s1', 'sonnet', 'medium')
    stored[RECORD_KEY] = {
      modelId: 'retired',
      configValues: { permission: 'bypass' },
      modelValues: { retired: { effort: 'low' } }
    }

    await reapplyPersistedComposerOptions(useAcpStore.getState as never, 's1', CONFIG)

    expect(wire).toEqual(['permission=bypass'])
    expect(warnsFrom('acp.reapplyComposerOptions')).toEqual([
      "saved model is not advertised on session s1; kept the session's model and its values"
    ])
  })

  it('a legacy record (flat values, no per-model values) restores as before', async () => {
    seedChat('s1', 'opus', 'high')
    stored[RECORD_KEY] = { modelId: 'opus', configValues: { model: 'opus', effort: 'low' } }

    await reapplyPersistedComposerOptions(useAcpStore.getState as never, 's1', CONFIG)

    expect(wire).toEqual(['effort=low'])
  })

  it('a reopened chat keeps its own model and values from the agent-wide reapply until it is closed', async () => {
    seedChat('s1', 'opus', 'low')
    reopenRestores.set('s1', 'restored')
    stored[RECORD_KEY] = {
      modelId: 'sonnet',
      configValues: { permission: 'bypass' },
      modelValues: { sonnet: { effort: 'low' } }
    }

    await reapplyPersistedComposerOptions(useAcpStore.getState as never, 's1', CONFIG)
    // Mode is agent-level: it still heals.
    expect(wire).toEqual(['permission=bypass'])

    dropSessionBookkeeping('s1')
    await reapplyPersistedComposerOptions(useAcpStore.getState as never, 's1', CONFIG)
    expect(wire).toEqual(['permission=bypass', 'model=sonnet', 'effort=low'])
  })

  it('a launcher value whose option is advertised but not the value is skipped with a warn', async () => {
    seedChat('s1', 'sonnet', 'medium')

    await useAcpStore.getState().applyPendingLauncherOptions('s1', {
      modelId: 'sonnet',
      configValues: { effort: 'high' }
    })

    expect(wire).toEqual([])
    expect(warnsFrom('acp.applyPendingLauncherOptions')).toEqual([
      "Skipped option 'effort' on session s1: the value is not advertised by this session"
    ])
  })

  it('a saved record reads back at once, before its debounced write flushes', async () => {
    stored[RECORD_KEY] = {
      modelId: 'opus',
      modeId: 'plan',
      modelValues: { sonnet: { effort: 'low' } }
    }
    mockPersistenceApi.writeDebounced.mockImplementation(() => new Promise(() => {}))

    persistComposerOptions(CONFIG, {
      modelId: undefined,
      configValues: { effort: 'high' },
      modelValues: { opus: { effort: 'high' } }
    })

    expect(await readComposerOptions(CONFIG)).toEqual({
      modelId: 'opus',
      modeId: 'plan',
      configValues: { effort: 'high' },
      modelValues: { sonnet: { effort: 'low' }, opus: { effort: 'high' } }
    })
  })

  it('a reapply waits while a model pick runs on the chat', async () => {
    seedChat('s1', 'opus', 'high')
    stored[RECORD_KEY] = { modelId: 'opus', modelValues: { opus: { effort: 'low' } } }
    latestModelPick.set('s1', 1)

    await reapplyPersistedComposerOptions(useAcpStore.getState as never, 's1', CONFIG)
    expect(wire).toEqual([])

    latestModelPick.delete('s1')
    await reapplyPersistedComposerOptions(useAcpStore.getState as never, 's1', CONFIG)
    expect(wire).toEqual(['effort=low'])
  })

  it('a launcher apply on native models waits for the new effort choices', async () => {
    const effortsBy: Record<string, string[]> = { opus: ['low', 'high'], sonnet: ['low'] }
    const nativeEffort = (model: string, current: string) =>
      makeConfigOption('effort', current, effortsBy[model] ?? [], 'thought_level')
    seedOptionsSession('s1', 'agent-1', {
      models: {
        currentModelId: 'sonnet',
        availableModels: [
          { modelId: 'opus', name: 'Opus' },
          { modelId: 'sonnet', name: 'Sonnet' }
        ]
      },
      configOptions: [nativeEffort('sonnet', 'low')]
    })
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      const { modelId, configId, valueId } = args as Record<string, string>
      if (command === 'acp_set_model') {
        wire.push(`model=${modelId}`)
        setTimeout(() => {
          useAcpStore.setState((s) => ({
            sessions: {
              ...s.sessions,
              s1: { ...s.sessions.s1, configOptions: [nativeEffort(modelId, 'low')] }
            }
          }))
        }, 30)
        return null
      }
      wire.push(`${configId}=${valueId}`)
      return [nativeEffort('opus', valueId)]
    })

    await useAcpStore
      .getState()
      .applyPendingLauncherOptions('s1', { modelId: 'opus', configValues: { effort: 'high' } })

    expect(wire).toEqual(['model=opus', 'effort=high'])
    expect(effortOf('s1')).toBe('high')
  })

  it("a launch whose model does not apply skips that model's values but keeps the mode", async () => {
    seedOptionsSession('s1', 'agent-1', {
      models: {
        currentModelId: 'sonnet',
        availableModels: [{ modelId: 'sonnet', name: 'Sonnet' }]
      },
      configOptions: [effortOption('opus', 'medium'), permissionOption('default')]
    })
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'acp_set_model') throw new Error('unknown model')
      const { configId, valueId } = args as Record<string, string>
      wire.push(`${configId}=${valueId}`)
      return [effortOption('opus', 'medium'), permissionOption(valueId)]
    })

    await useAcpStore.getState().applyPendingLauncherOptions('s1', {
      modelId: 'opus',
      configValues: { effort: 'high', permission: 'bypass' }
    })

    expect(wire).toEqual(['permission=bypass'])
    expect(warnsFrom('acp.applyPendingLauncherOptions')).toEqual([
      "Skipped option 'effort' on session s1: the model is not advertised by this session"
    ])
  })

  it('a reapply triggered while one runs runs once more after it', async () => {
    seedChat('s1', 'opus', 'high')

    const first = reapplyPersistedComposerOptions(useAcpStore.getState as never, 's1', CONFIG)
    stored[RECORD_KEY] = { modelId: 'opus', modelValues: { opus: { effort: 'low' } } }
    await reapplyPersistedComposerOptions(useAcpStore.getState as never, 's1', CONFIG)
    await first

    await vi.waitFor(() => expect(wire).toEqual(['effort=low']))
  })

  it('an effort set while the model moves is not saved under either model', async () => {
    seedChat('s1', 'opus', 'high')
    vi.mocked(invoke).mockImplementation(async (_command: string, args?: unknown) => {
      const { configId, valueId } = args as Record<string, string>
      wire.push(`${configId}=${valueId}`)
      // Another surface switched the chat to Sonnet before this reply.
      useAcpStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          s1: {
            ...s.sessions.s1,
            configOptions: [modelOption('sonnet'), effortOption('sonnet', 'low')]
          }
        }
      }))
      return [modelOption('sonnet'), effortOption('sonnet', valueId)]
    })

    await useAcpStore.getState().setConfigOption('s1', 'effort', 'low')
    await settleWrites()

    expect(stored[RECORD_KEY]).toEqual({ configValues: { effort: 'low' } })
  })

  describe('an armed agent switch', () => {
    const TARGET = 'cfg-target'
    const TARGET_KEY = `agents/composer-options/${TARGET}`

    function armSwitch(id: string): void {
      seedChat(id, 'haiku', 'medium')
      useAcpStore.setState((s) => ({
        sessions: {
          ...s.sessions,
          [id]: { ...s.sessions[id], switching: { toConfigId: TARGET, status: 'pending' } }
        },
        agentOptionsCache: {
          ...s.agentOptionsCache,
          [TARGET]: {
            models: null,
            modes: null,
            configOptions: [
              modelOption('sonnet'),
              effortOption('opus', 'medium'),
              permissionOption('default')
            ]
          }
        }
      }))
    }

    const armed = (id: string) => useAcpStore.getState().sessions[id].switching?.pendingOptions

    it('saves an effort change under the armed model', async () => {
      armSwitch('s1')
      await useAcpStore
        .getState()
        .setSwitchPendingOption('s1', { modelId: 'opus', configValues: { model: 'opus' } })

      await useAcpStore
        .getState()
        .setSwitchPendingOption('s1', { configValues: { effort: 'high' } })
      await settleWrites()

      expect(stored[TARGET_KEY]).toEqual({
        modelId: 'opus',
        configValues: { model: 'opus', effort: 'high' },
        modelValues: { opus: { effort: 'high' } }
      })
    })

    it('a model pick with no target options known keeps the earlier values', async () => {
      armSwitch('s1')
      useAcpStore.setState(
        (s) => ({ agentOptionsCache: { ...s.agentOptionsCache, [TARGET]: undefined } }) as never
      )
      await useAcpStore.getState().setSwitchPendingOption('s1', {
        modelId: 'opus',
        configValues: { effort: 'high', permission: 'bypass' }
      })

      await useAcpStore.getState().setSwitchPendingOption('s1', { modelId: 'sonnet' })

      expect(armed('s1')).toEqual({
        modelId: 'sonnet',
        modeId: undefined,
        configValues: { effort: 'high', permission: 'bypass' }
      })
    })

    it("classifies a pick against the target's prepared session when the cache is empty", async () => {
      armSwitch('s1')
      seedOptionsSession('s-warm', 'agent-2', {
        configOptions: [
          modelOption('sonnet'),
          effortOption('opus', 'medium'),
          permissionOption('default')
        ]
      })
      useAcpStore.setState(
        (s) =>
          ({
            agentOptionsCache: { ...s.agentOptionsCache, [TARGET]: undefined },
            preparedSessions: {
              ...s.preparedSessions,
              [prepareChatKey(TARGET, '/work', undefined)]: 's-warm'
            }
          }) as never
      )
      await useAcpStore.getState().setSwitchPendingOption('s1', {
        modelId: 'opus',
        configValues: { model: 'opus', effort: 'high', permission: 'bypass' }
      })

      await useAcpStore
        .getState()
        .setSwitchPendingOption('s1', { modelId: 'sonnet', configValues: { model: 'sonnet' } })

      expect(armed('s1')?.configValues).toEqual({ permission: 'bypass', model: 'sonnet' })
    })

    it("a model pick replaces the last model's values and keeps the mode", async () => {
      armSwitch('s1')
      await useAcpStore.getState().setSwitchPendingOption('s1', {
        modelId: 'opus',
        configValues: { model: 'opus', effort: 'high', permission: 'bypass' }
      })

      await useAcpStore
        .getState()
        .setSwitchPendingOption('s1', { modelId: 'sonnet', configValues: { model: 'sonnet' } })

      expect(armed('s1')).toEqual({
        modelId: 'sonnet',
        modeId: undefined,
        configValues: { permission: 'bypass', model: 'sonnet' }
      })
    })
  })
})
