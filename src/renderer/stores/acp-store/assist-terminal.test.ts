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
import {
  _resetAcpAuthForTesting,
  _resetCoalesceForTesting,
  _resetEphemeralSessionIdsForTesting,
  _resetInFlightHistoryOpensForTesting,
  _resetInFlightPreparedForTesting,
  _resetSessionIndexLoadGenerationForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH } from './testkit'

describe('assistTerminal (#259)', () => {
  beforeEach(() => {
    _resetAcpTransportForTests(null)
    _resetInFlightHistoryOpensForTesting()
    _resetAcpAuthForTesting()
    _resetInFlightPreparedForTesting()
    _resetCoalesceForTesting()
    _resetEphemeralSessionIdsForTesting()
    _resetSessionIndexLoadGenerationForTesting()
    useAcpStore.setState(FRESH)
  })

  it('explains selected output through a hidden one-shot session and disposes it', async () => {
    useAcpStore.setState({
      selectedAgentConfigId: 'cfg-1',
      agentConfigs: [{ id: 'cfg-1', name: 'Agent', command: 'agent', args: [], env: {} }]
    })
    let promptBody = ''
    vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'acp_spawn_agent')
        return { agentId: 'agent-1', capabilities: {}, authMethods: [] }
      if (command === 'acp_new_session') return { sessionId: 'assist-session' }
      if (command === 'acp_send_prompt') {
        promptBody = String((args as { text?: string }).text ?? '')
        useAcpStore.getState()._onMessageChunk({
          agentId: 'agent-1',
          sessionId: 'assist-session',
          role: 'agent',
          content: { type: 'text', text: 'The command failed because ' }
        })
        useAcpStore.getState()._onMessageChunk({
          agentId: 'agent-1',
          sessionId: 'assist-session',
          role: 'agent',
          content: { type: 'text', text: 'the port is in use.\n```sh\nlsof -i :3000\n```' }
        })
        useAcpStore.getState()._onPromptComplete({
          agentId: 'agent-1',
          sessionId: 'assist-session',
          stopReason: 'end_turn'
        })
        return 'end_turn'
      }
      if (command === 'acp_dispose_ephemeral_session') return undefined
      throw new Error(`unexpected invoke command: ${command}`)
    })

    await expect(
      useAcpStore.getState().assistTerminal('explain', '/work', 'Error: EADDRINUSE', 1)
    ).resolves.toContain('lsof -i :3000')

    // The untrusted selection travels JSON-encoded and the prompt forbids tools.
    expect(promptBody).toContain('"Error: EADDRINUSE"')
    expect(promptBody).toContain('Do not use tools')
    // No visible session/transcript state survives.
    expect(useAcpStore.getState().sessions['assist-session']).toBeUndefined()
    expect(useAcpStore.getState().messages['assist-session']).toBeUndefined()
    expect(
      vi.mocked(invoke).mock.calls.some(([command]) => command === 'acp_dispose_ephemeral_session')
    ).toBe(true)
    expect(vi.mocked(invoke).mock.calls.some(([command]) => command === 'acp_close_session')).toBe(
      false
    )
  })

  it('fails fast without a configured agent', async () => {
    await expect(
      useAcpStore.getState().assistTerminal('fix', '/work', 'boom', 127)
    ).rejects.toThrow('Configure and select an ACP agent')
  })

  it('rejects empty or oversized selections', async () => {
    await expect(useAcpStore.getState().assistTerminal('fix', '/work', '   ', 1)).rejects.toThrow(
      'No terminal output selected'
    )
    await expect(
      useAcpStore.getState().assistTerminal('fix', '/work', 'x'.repeat(20_001), 1)
    ).rejects.toThrow('too large')
  })
})
