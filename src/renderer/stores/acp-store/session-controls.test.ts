/**
 * Reopening a chat after a page reload restores its model, mode, and config
 * controls from the host payload, so the picker lists the session's models
 * instead of "no model choice". Controls the client already holds win.
 *
 * Same harness as live-turn-attach-replay.test.ts: a fake web transport whose
 * listing names a live owner, so the reopen attaches to the running turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn() }
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
vi.mock('@/lib/api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/api')>()
  return {
    ...actual,
    persistenceApi: {
      read: vi.fn(async () => ({ success: false })),
      write: vi.fn(),
      writeDebounced: vi.fn(async () => ({ success: true })),
      delete: vi.fn(async () => ({ success: true }))
    }
  }
})

import { toast } from 'sonner'
import { catalogFromSessionState } from '@/components/chat/agent-model-selector/selector-model'
import type { SessionConfigOption } from '@/lib/acp-api'
import type { AcpTransport } from '@/lib/acp-transport'
import { _resetAcpTransportForTests, _setAcpTransportForTests } from '@/lib/acp-transport'
import { persistenceApi } from '@/lib/api'
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
import { reapplyPersistedComposerOptions } from './helpers'
import { deferred, FRESH } from './testkit'

const CONFIG_ID = 'acp-registry:claude-acp'
const AGENT = 'agent-owner'

function fakeWebTransport(
  sessionId: string,
  payload: Promise<Record<string, unknown>>
): AcpTransport {
  return {
    listAgentDetails: async () => [
      {
        id: AGENT,
        name: 'Claude',
        configId: CONFIG_ID,
        capabilities: { loadSession: true },
        ownsSession: [sessionId]
      }
    ],
    spawnAgent: vi.fn(async () => ({
      agentId: 'agent-fresh',
      capabilities: { loadSession: true }
    })),
    loadSession: vi.fn(async () => ({})),
    resumeSession: vi.fn(async () => ({})),
    sendPrompt: vi.fn(async () => 'end_turn'),
    sendPromptBlocks: vi.fn(async () => 'end_turn'),
    getSessionPayload: async (id: string) => (id === sessionId ? payload : null),
    getSessionPayloadTail: async () => null,
    subscribeSession: vi.fn(async () => {}),
    seedSessionCursor: vi.fn(),
    connect: async () => {},
    dispose: () => {},
    historyMode: () => 'server' as const
  } as unknown as AcpTransport
}

function liveTurnPayload(id: string, controls: Record<string, unknown>): Record<string, unknown> {
  return {
    metadata: {
      id,
      agentId: AGENT,
      agentConfigId: CONFIG_ID,
      title: 'Chat',
      cwd: '/w',
      projectId: 'p1',
      createdAt: 1,
      lastActivityAt: 2,
      messageCount: 1,
      lastSeq: 12,
      status: 'active',
      turnActive: true
    },
    messages: [
      {
        id: 'turn:t1',
        role: 'user',
        blocks: [{ type: 'text', text: 'refactor auth' }],
        streaming: false,
        timestamp: 7,
        seq: 7
      }
    ],
    ...controls
  }
}

const MODEL_OPTION: SessionConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'opus',
  options: [
    { value: 'sonnet', name: 'Sonnet' },
    { value: 'opus', name: 'Opus' }
  ]
}

function effortOption(currentValue: string): SessionConfigOption {
  return {
    id: 'effort',
    name: 'Effort',
    type: 'select',
    currentValue,
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' }
    ]
  }
}

const PAYLOAD_CONTROLS = {
  configOptions: [MODEL_OPTION, effortOption('low')],
  modes: {
    currentModeId: 'plan',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' }
    ]
  },
  // session_created's projection still names the model the chat started on.
  models: {
    currentModelId: 'sonnet',
    availableModels: [
      { modelId: 'sonnet', name: 'Sonnet' },
      { modelId: 'opus', name: 'Opus' }
    ]
  },
  controlsSeq: 6
}

function restoreLogs(): string[] {
  return vi
    .mocked(logFrontendError)
    .mock.calls.map(([entry]) => entry)
    .filter((entry) => entry.source === 'acp.reopenControls')
    .map((entry) => entry.message)
}

describe('acp-store: reopen restores session controls from the payload', () => {
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

  it('a reload mid-turn shows the session models with the current one selected', async () => {
    const id = 's-reload-controls'
    _setAcpTransportForTests(
      fakeWebTransport(id, Promise.resolve(liveTurnPayload(id, PAYLOAD_CONTROLS)))
    )

    await useAcpStore.getState().openHistorySession(id)

    const session = useAcpStore.getState().sessions[id]
    expect(session.status).toBe('active')
    expect(catalogFromSessionState(session.models, session.configOptions)).toEqual({
      id: 'model',
      source: 'config',
      options: [
        expect.objectContaining({ value: 'sonnet', name: 'Sonnet' }),
        expect.objectContaining({ value: 'opus', name: 'Opus' })
      ],
      currentValue: 'opus'
    })
    expect(session.models?.currentModelId).toBe('opus')
    expect(session.modes).toEqual(PAYLOAD_CONTROLS.modes)
    expect(session.configOptions).toEqual(PAYLOAD_CONTROLS.configOptions)
    expect(restoreLogs()).toEqual([
      `Restored controls for session ${id} from the history payload (seq 6: 2 config options, 2 models, 2 modes)`
    ])
  })

  it('a config update that lands while the payload loads keeps its value and the payload fills the rest', async () => {
    const id = 's-raced-controls'
    const payload = deferred<Record<string, unknown>>()
    _setAcpTransportForTests(fakeWebTransport(id, payload.promise))
    useAcpStore.setState({
      sessions: {
        [id]: {
          id,
          agentId: AGENT,
          cwd: '/w',
          projectId: 'p1',
          status: 'closed',
          title: 'Chat',
          activeTurn: false,
          openTurnId: null,
          modes: null,
          models: null,
          configOptions: [],
          lastError: null,
          createdAt: 1,
          replaying: null
        }
      }
    })

    const open = useAcpStore.getState().openHistorySession(id)
    useAcpStore.getState()._onConfigOptionsUpdate({
      agentId: AGENT,
      sessionId: id,
      configOptions: [effortOption('high')]
    })
    payload.resolve(liveTurnPayload(id, PAYLOAD_CONTROLS))
    await open

    const session = useAcpStore.getState().sessions[id]
    expect(session.configOptions).toEqual([effortOption('high')])
    expect(session.modes).toEqual(PAYLOAD_CONTROLS.modes)
    expect(session.models).toEqual(PAYLOAD_CONTROLS.models)
    expect(catalogFromSessionState(session.models, session.configOptions)).toMatchObject({
      source: 'models',
      currentValue: 'sonnet'
    })
    expect(restoreLogs()).toEqual([
      `Restored controls for session ${id} from the history payload (seq 6: 0 config options, 2 models, 2 modes)`
    ])
  })

  it('a payload from an older host leaves the session without controls', async () => {
    const id = 's-legacy-controls'
    _setAcpTransportForTests(fakeWebTransport(id, Promise.resolve(liveTurnPayload(id, {}))))

    await useAcpStore.getState().openHistorySession(id)

    const session = useAcpStore.getState().sessions[id]
    expect(session.status).toBe('active')
    expect(session.modes).toBeNull()
    expect(session.models).toBeNull()
    expect(session.configOptions).toEqual([])
    expect(catalogFromSessionState(session.models, session.configOptions)).toBeNull()
    expect(restoreLogs()).toEqual([])
  })
})

describe('acp-store: a reopened chat comes back on its own model and values', () => {
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
    useAcpStore.setState({
      agentConfigs: [{ id: CONFIG_ID, name: 'Claude', command: 'claude', args: [], env: {} }]
    })
  })

  /** A finished chat that last ran Opus at low effort. */
  function idlePayload(id: string, controls: Record<string, unknown>): Record<string, unknown> {
    const payload = liveTurnPayload(id, controls)
    return {
      ...payload,
      metadata: { ...(payload.metadata as object), status: 'closed', turnActive: false },
      messages: [
        ...(payload.messages as unknown[]),
        {
          id: 'turn:t1:reply',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'done' }],
          streaming: false,
          timestamp: 8,
          seq: 8
        }
      ]
    }
  }

  const PERMISSION = (currentValue: string): SessionConfigOption => ({
    id: 'permission',
    name: 'Permission',
    category: 'mode',
    type: 'select',
    currentValue,
    options: [
      { value: 'default', name: 'Default' },
      { value: 'bypass', name: 'Bypass' }
    ]
  })

  const CONTEXT = (currentValue: string): SessionConfigOption => ({
    id: 'context',
    name: 'Context',
    type: 'select',
    currentValue,
    options: [
      { value: '200k', name: '200K' },
      { value: '1m', name: '1M' }
    ]
  })

  /**
   * Reopen a chat that last ran Opus at low effort with a 1M context in
   * bypass mode, on an agent that reopens it on its defaults (Sonnet, high,
   * 200K, default). Returns the wire's set_config_option calls.
   */
  async function reopen(
    id: string,
    opts: {
      capabilities?: Record<string, unknown>
      /** Return a value to answer the call, throw to reject it. */
      onSet?: (configId: string, valueId: string) => void | Promise<void>
      /** The model the chat last ran (default Opus). */
      chatModel?: string
      /** Throw to fail `session/resume`. */
      onResume?: () => void
      /** False when the restore is held by `onSet`: the open settles only after it. */
      awaitOpen?: boolean
    } = {}
  ): Promise<{ wire: string[]; transport: AcpTransport; opened: Promise<void> }> {
    const wire: string[] = []
    const agent = { model: 'sonnet', effort: 'high', context: '200k', permission: 'default' }
    const advertised = () => [
      { ...MODEL_OPTION, currentValue: agent.model },
      effortOption(agent.effort),
      CONTEXT(agent.context),
      PERMISSION(agent.permission)
    ]
    const base = fakeWebTransport(
      id,
      Promise.resolve(
        idlePayload(id, {
          configOptions: [
            { ...MODEL_OPTION, currentValue: opts.chatModel ?? 'opus' },
            effortOption('low'),
            CONTEXT('1m'),
            PERMISSION('bypass')
          ],
          controlsSeq: 6
        })
      )
    )
    const capabilities = opts.capabilities ?? { loadSession: true }
    const transport = {
      ...base,
      listAgentDetails: async () =>
        (await base.listAgentDetails()).map((detail) => ({ ...detail, capabilities })),
      loadSession: vi.fn(async () => ({ configOptions: advertised() })),
      resumeSession: vi.fn(async () => {
        opts.onResume?.()
        return { configOptions: advertised() }
      }),
      setConfigOption: vi.fn(
        async (_agent: string, _session: string, configId: string, valueId: string) => {
          await opts.onSet?.(configId, valueId)
          wire.push(`${configId}=${valueId}`)
          if (configId === 'model') {
            agent.model = valueId
            agent.effort = 'high'
          } else if (configId === 'permission') {
            agent.permission = valueId
          } else if (configId === 'context') {
            agent.context = valueId
          } else {
            agent.effort = valueId
          }
          return advertised()
        }
      )
    } as unknown as AcpTransport
    _setAcpTransportForTests(transport)
    const opened = useAcpStore.getState().openHistorySession(id)
    if (opts.awaitOpen !== false) await opened
    return { wire, transport, opened }
  }

  const controlsOf = (id: string) =>
    useAcpStore.getState().sessions[id].configOptions.map((o) => [o.id, o.currentValue])

  it('re-applies the chat model, then its effort, over the agent reply (session/load)', async () => {
    const id = 's-load-own'
    const { wire } = await reopen(id)

    await vi.waitFor(() => expect(wire).toEqual(['model=opus', 'effort=low', 'context=1m']))
    expect(controlsOf(id)).toEqual([
      ['model', 'opus'],
      ['effort', 'low'],
      ['context', '1m'],
      ['permission', 'default']
    ])
  })

  it('re-applies the chat model, then its effort, over the agent reply (session/resume)', async () => {
    const id = 's-resume-own'
    const { wire, transport } = await reopen(id, {
      capabilities: { loadSession: true, sessionCapabilities: { resume: {} } }
    })

    await vi.waitFor(() => expect(wire).toEqual(['model=opus', 'effort=low', 'context=1m']))
    expect(transport.resumeSession).toHaveBeenCalled()
    expect(transport.loadSession).not.toHaveBeenCalled()
  })

  it("leaves permission mode and the agent's saved composer record alone", async () => {
    const id = 's-own-no-write'
    const { wire } = await reopen(id)

    await vi.waitFor(() => expect(wire).toEqual(['model=opus', 'effort=low', 'context=1m']))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const composerWrites = vi
      .mocked(persistenceApi.writeDebounced)
      .mock.calls.filter(([key]) => String(key).startsWith('agents/composer-options/'))
    expect(composerWrites).toEqual([])
    expect(controlsOf(id)).toContainEqual(['permission', 'default'])
  })

  it('keeps the agent value when the agent rejects the chat value, with a warn', async () => {
    const id = 's-own-rejected'
    const { wire } = await reopen(id, {
      onSet: (configId) => {
        if (configId === 'effort') throw new Error('effort rejected')
      }
    })

    await vi.waitFor(() =>
      expect(
        vi
          .mocked(logFrontendError)
          .mock.calls.map(([entry]) => entry)
          .filter((entry) => entry.source === 'acp.applyPendingLauncherOptions')
          .map((entry) => [entry.level, entry.message])
      ).toEqual([
        ['warn', `Skipping option 'effort' on session ${id} after apply failure: effort rejected`]
      ])
    )
    expect(wire).toEqual(['model=opus', 'context=1m'])
    expect(controlsOf(id)).toContainEqual(['effort', 'high'])
  })

  it('a model the user picks while the restore runs wins over the chat values', async () => {
    const id = 's-own-user-wins'
    const effortSet = deferred<void>()
    let userPick: Promise<void> | null = null
    const { wire, opened } = await reopen(id, {
      awaitOpen: false,
      onSet: (configId) => {
        if (configId !== 'effort') return
        // The user picks Sonnet while the restore's effort is in flight.
        userPick = useAcpStore.getState().pickModel(id, 'sonnet')
        return effortSet.promise
      }
    })
    await vi.waitFor(() => expect(userPick).not.toBeNull())
    await userPick
    effortSet.resolve()

    await vi.waitFor(() => expect(wire).toEqual(['model=opus', 'model=sonnet', 'effort=low']))
    await opened
    expect(wire).not.toContain('context=1m')
  })

  it('restores the chat model and values after a resume miss falls back to session/load', async () => {
    const id = 's-resume-miss'
    const { wire, transport } = await reopen(id, {
      capabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      onResume: () => {
        throw new Error('session not found')
      }
    })

    await vi.waitFor(() => expect(wire).toEqual(['model=opus', 'effort=low', 'context=1m']))
    expect(transport.loadSession).toHaveBeenCalled()
  })

  it("never sends the agent-wide last model after the chat's own", async () => {
    vi.mocked(persistenceApi.read).mockImplementation(async (key: string) =>
      key === `agents/composer-options/${CONFIG_ID}`
        ? ({
            success: true,
            data: {
              modelId: 'sonnet',
              configValues: { model: 'sonnet' },
              modelValues: { sonnet: { effort: 'high' } }
            }
          } as never)
        : ({ success: false } as never)
    )
    try {
      const id = 's-own-over-agent-wide'
      const { wire } = await reopen(id)

      await vi.waitFor(() => expect(wire).toEqual(['model=opus', 'effort=low', 'context=1m']))
      await reapplyPersistedComposerOptions(useAcpStore.getState as never, id, CONFIG_ID)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(wire).toEqual(['model=opus', 'effort=low', 'context=1m'])
    } finally {
      vi.mocked(persistenceApi.read).mockImplementation(async () => ({ success: false }) as never)
    }
  })

  it('an option the user sets while the restore runs is not overwritten', async () => {
    const id = 's-own-user-option'
    const modelSet = deferred<void>()
    let userSet: Promise<void> | null = null
    const { wire, opened } = await reopen(id, {
      awaitOpen: false,
      onSet: (configId) => {
        if (configId !== 'model') return
        // The user picks a 200K context while the restore's model switch is in flight.
        userSet = useAcpStore.getState().setConfigOption(id, 'context', '200k')
        return modelSet.promise
      }
    })
    await vi.waitFor(() => expect(userSet).not.toBeNull())
    await userSet
    modelSet.resolve()

    await vi.waitFor(() => expect(wire).toEqual(['context=200k', 'model=opus', 'effort=low']))
    await opened
    expect(wire).not.toContain('context=1m')
    expect(controlsOf(id)).toContainEqual(['context', '200k'])
  })

  it('keeps the agent model, with a warn and no calls, when the chat model is gone', async () => {
    vi.mocked(persistenceApi.read).mockImplementation(async (key: string) =>
      key === `agents/composer-options/${CONFIG_ID}`
        ? ({ success: true, data: { modelId: 'opus' } } as never)
        : ({ success: false } as never)
    )
    try {
      const id = 's-own-model-gone'
      const { wire } = await reopen(id, { chatModel: 'retired' })

      await vi.waitFor(() =>
        expect(
          vi
            .mocked(logFrontendError)
            .mock.calls.map(([entry]) => entry)
            .filter((entry) => entry.source === 'acp.reopenSelection')
            .map((entry) => [entry.level, entry.message])
        ).toEqual([
          [
            'warn',
            `Session ${id} reopened without its last model: the agent no longer offers it; kept the agent's model and values`
          ]
        ])
      )
      await reapplyPersistedComposerOptions(useAcpStore.getState as never, id, CONFIG_ID)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(wire).toEqual([])
      expect(controlsOf(id)[0]).toEqual(['model', 'sonnet'])
    } finally {
      vi.mocked(persistenceApi.read).mockImplementation(async () => ({ success: false }) as never)
    }
  })

  it('a rejected model switch shows no toast and sends no chat values', async () => {
    const id = 's-own-model-rejected'
    const { wire, transport } = await reopen(id, {
      onSet: (configId) => {
        if (configId === 'model') throw new Error('model rejected')
      }
    })

    await vi.waitFor(() => expect(transport.setConfigOption).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(wire).toEqual([])
    expect(toast.error).not.toHaveBeenCalled()
    expect(controlsOf(id)).toContainEqual(['effort', 'high'])
  })

  it('a prompt typed while the restore runs is sent on the chat model and values', async () => {
    const id = 's-own-queued-prompt'
    const modelSet = deferred<void>()
    let typed: Promise<void> | null = null
    const { wire, transport, opened } = await reopen(id, {
      awaitOpen: false,
      onSet: (configId) => {
        if (configId !== 'model') return
        typed = useAcpStore.getState().sendPrompt(id, 'next step')
        return modelSet.promise
      }
    })
    const sends = () =>
      [
        ...vi.mocked(transport.sendPrompt).mock.calls,
        ...vi.mocked(transport.sendPromptBlocks).mock.calls
      ].length
    await vi.waitFor(() => expect(typed).not.toBeNull())
    expect(sends()).toBe(0)

    modelSet.resolve()
    await opened
    await vi.waitFor(() => expect(sends()).toBe(1))
    expect(wire).toEqual(['model=opus', 'effort=low', 'context=1m'])
  })
})
