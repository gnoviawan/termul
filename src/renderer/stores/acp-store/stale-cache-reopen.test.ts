/**
 * Live incident 2026-10-15 (chat 9c29cfaf): a Claude account switch restarted
 * a background chat the moment its turn ended. The reopen installed the
 * renderer's cached full payload, left by a scroll-up minutes earlier, instead
 * of the host's history, so the turn's final reply vanished and only the
 * opening messages plus "Worked for…" remained.
 *
 * The suite drives the real restart → `retryCrashedSession` → reopen path
 * with the REAL history loaders and payload cache. A fake web transport plays
 * the host in server history mode; `acpHistoryApi` plays it in desktop history
 * mode (same harness shape as dead-turn-reopen.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { historyApi } = vi.hoisted(() => ({
  historyApi: {
    list: vi.fn(),
    get: vi.fn(),
    getTail: vi.fn(),
    flush: vi.fn()
  }
}))

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
vi.mock('@/lib/acp-history-api', () => ({ acpHistoryApi: historyApi }))
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
  // Both payload loaders and the cache stay REAL: the fakes are the host.
  return {
    ...actual,
    loadSessionIndex: vi.fn(async () => []),
    saveSessionIndex: vi.fn(async () => {}),
    saveSessionPayload: vi.fn(async () => {}),
    queueSessionPayloadSave: vi.fn(async () => {}),
    queueSessionPayloadDelete: vi.fn(async () => {})
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

import type { ChatMessage } from '@/lib/acp-api'
import {
  _clearPayloadCacheForTesting,
  getCachedSessionPayload,
  HISTORY_TAIL_MESSAGE_LIMIT,
  type SessionPayload,
  setCachedSessionPayload
} from '@/lib/acp-history-persistence'
import type { AcpTransport } from '@/lib/acp-transport'
import { _resetAcpTransportForTests, _setAcpTransportForTests } from '@/lib/acp-transport'
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
import { restartClaudeSession } from '@/stores/claude-account-switch'
import { FRESH } from './testkit'

const CONFIG_ID = 'acp-registry:claude-acp'
const SESSION = 's-background'
const OLD_AGENT = 'agent-old-account'
const FRESH_AGENT = 'agent-new-account'
const FINAL_REPLY = 'The spec is ready for your approval.'

const message = (
  id: string,
  role: ChatMessage['role'],
  text: string,
  seq: number
): ChatMessage => ({
  id,
  role,
  blocks: [{ type: 'text', text }],
  streaming: false,
  timestamp: 0,
  seq
})

/** A host-folded message: the ids `session_payload.rs` mints. */
const hostMessage = (role: 'user' | 'agent', text: string, seq: number): ChatMessage =>
  message(role === 'user' ? `user:seq-${seq}` : `snapshot:agent:${seq}`, role, text, seq)

const hostPayload = (messages: ChatMessage[], lastSeq: number): SessionPayload => ({
  metadata: {
    id: SESSION,
    agentId: OLD_AGENT,
    agentConfigId: CONFIG_ID,
    title: 'Sidebar polish',
    cwd: '/w',
    projectId: 'p1',
    createdAt: 1,
    lastActivityAt: 2,
    messageCount: messages.length,
    lastSeq,
    logEpoch: 'epoch-1',
    status: 'active'
  },
  messages
})

const textOf = (m: ChatMessage): string =>
  m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')

function fakeTransport(historyMode: 'server' | 'tauri_store', tail: SessionPayload) {
  return {
    listAgentDetails: async () => [],
    spawnAgent: vi.fn(async () => ({
      agentId: FRESH_AGENT,
      capabilities: { loadSession: true, sessionCapabilities: { resume: {} } }
    })),
    killAgent: vi.fn(async () => {}),
    loadSession: vi.fn(async () => ({})),
    resumeSession: vi.fn(async () => ({})),
    getSessionPayload: vi.fn(async () => tail),
    getSessionPayloadTail: vi.fn(async () => tail),
    subscribeSession: vi.fn(async () => {}),
    seedSessionCursor: vi.fn(),
    connect: async () => {},
    dispose: () => {},
    historyMode: () => historyMode
  }
}

/** A connected, idle Claude chat whose live transcript shows the whole turn. */
function seedLiveChat(liveMessages: ChatMessage[]): void {
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
    ],
    agents: {
      [OLD_AGENT]: {
        id: OLD_AGENT,
        capabilities: { loadSession: true, sessionCapabilities: { resume: {} } }
      }
    } as never,
    agentStatus: { [OLD_AGENT]: 'connected' },
    configToLiveAgent: { [`${CONFIG_ID}\0/w\0p1`]: OLD_AGENT },
    sessions: {
      [SESSION]: {
        id: SESSION,
        agentId: OLD_AGENT,
        cwd: '/w',
        projectId: 'p1',
        status: 'active',
        title: 'Sidebar polish',
        activeTurn: false,
        openTurnId: null,
        modes: null,
        models: null,
        configOptions: [],
        lastError: null,
        createdAt: 1
      }
    },
    messages: { [SESSION]: liveMessages }
  })
}

describe('acp-store: a reopen never installs a stale cached transcript', () => {
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
    _clearPayloadCacheForTesting()
    useAcpStore.setState(FRESH)
  })

  it('server history: an account-switch restart right after a background turn keeps its final reply', async () => {
    const hostMessages = [
      hostMessage('user', 'run the build workflow', 7),
      hostMessage('agent', 'Running the build workflow.', 111),
      hostMessage('agent', FINAL_REPLY, 1478)
    ]
    const transport = fakeTransport('server', hostPayload(hostMessages, 1655))
    _setAcpTransportForTests(transport as unknown as AcpTransport)
    seedLiveChat([
      message('turn:prompt', 'user', 'run the build workflow', 7),
      message('msg-narration', 'agent', 'Running the build workflow.', 111),
      message('msg-final', 'agent', FINAL_REPLY, 1478)
    ])
    // A scroll-up early in the turn cached the full payload as it was then.
    setCachedSessionPayload(SESSION, hostPayload(hostMessages.slice(0, 1), 7))

    await expect(restartClaudeSession(SESSION)).resolves.toBe(true)

    // The host's transcript was installed: its ids, not the stale copy or the
    // live bubbles left in place.
    const installed = useAcpStore.getState().messages[SESSION] ?? []
    expect(installed.map((m) => m.id)).toEqual(hostMessages.map((m) => m.id))
    expect(installed.map(textOf)).toContain(FINAL_REPLY)
    expect(transport.killAgent).toHaveBeenCalledWith(OLD_AGENT)
    expect(transport.getSessionPayloadTail).toHaveBeenCalledWith(
      SESSION,
      HISTORY_TAIL_MESSAGE_LIMIT
    )
    expect(getCachedSessionPayload(SESSION)).toBeUndefined()
    expect(useAcpStore.getState().sessions[SESSION]?.agentId).toBe(FRESH_AGENT)
  })

  it('desktop history: after the restart, scroll-up refetches the host log instead of skipping a band', async () => {
    const hostMessages = Array.from({ length: 60 }, (_, i) =>
      hostMessage(i % 2 === 0 ? 'user' : 'agent', `message ${i + 1}`, (i + 1) * 10)
    )
    const full = hostPayload(hostMessages, 700)
    const tail = hostPayload(hostMessages.slice(-HISTORY_TAIL_MESSAGE_LIMIT), 700)
    historyApi.getTail.mockResolvedValue(tail)
    historyApi.get.mockResolvedValue(full)
    const transport = fakeTransport('tauri_store', tail)
    _setAcpTransportForTests(transport as unknown as AcpTransport)
    seedLiveChat(hostMessages.map((m, i) => ({ ...m, id: `live-${i + 1}` })))
    // Cached by a scroll-up when the chat held only its first five messages.
    setCachedSessionPayload(SESSION, hostPayload(hostMessages.slice(0, 5), 50))

    await expect(restartClaudeSession(SESSION)).resolves.toBe(true)

    expect(historyApi.getTail).toHaveBeenCalledWith(SESSION, HISTORY_TAIL_MESSAGE_LIMIT)
    expect(useAcpStore.getState().messages[SESSION]?.map((m) => m.id)).toEqual(
      hostMessages.slice(-HISTORY_TAIL_MESSAGE_LIMIT).map((m) => m.id)
    )

    await useAcpStore.getState().loadOlderMessages(SESSION, 50)

    // Every message, in order: the old five-message copy is not the anchor.
    expect(useAcpStore.getState().messages[SESSION]?.map((m) => m.id)).toEqual(
      hostMessages.map((m) => m.id)
    )
    expect(historyApi.get).toHaveBeenCalledWith(SESSION)
  })
})
