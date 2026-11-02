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

import { catalogFromSessionState } from '@/components/chat/agent-model-selector/selector-model'
import type { SessionConfigOption } from '@/lib/acp-api'
import type { AcpTransport } from '@/lib/acp-transport'
import { _resetAcpTransportForTests, _setAcpTransportForTests } from '@/lib/acp-transport'
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
