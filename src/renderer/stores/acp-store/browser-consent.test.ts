/**
 * spec-acp-browser-pane-agent-ui: respondBrowserConsent optimistic removal +
 * warn-log on a failed respond (Rust auto-denies on timeout — warn only).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockBrowserConsentRespond, mockLogFrontendError } = vi.hoisted(() => ({
  mockBrowserConsentRespond: vi.fn(),
  mockLogFrontendError: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() }
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: vi.fn(() => true),
  cleanupTauriListener: vi.fn()
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

vi.mock('@/lib/acp-api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/acp-api')>()
  return { ...actual, browserConsentRespond: mockBrowserConsentRespond }
})

vi.mock('@/lib/acp-agents-persistence', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/acp-agents-persistence')>()
  return {
    ...actual,
    loadAgentConfigs: vi.fn(async () => []),
    saveAgentConfigs: vi.fn(async () => {})
  }
})
vi.mock('@/lib/acp-history-persistence', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/acp-history-persistence')>()
  return {
    ...actual,
    loadSessionIndex: vi.fn(async () => []),
    saveSessionIndex: vi.fn(async () => {}),
    saveSessionPayload: vi.fn(async () => {}),
    queueSessionPayloadSave: vi.fn(async () => {}),
    queueSessionPayloadDelete: vi.fn(async () => {}),
    loadSessionPayload: vi.fn(async () => null),
    loadSessionPayloadTail: vi.fn(async () => null)
  }
})
vi.mock('@/lib/acp-mcp-persistence', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/acp-mcp-persistence')>()
  return {
    ...actual,
    loadMcpServers: vi.fn(async () => []),
    saveMcpServers: vi.fn(async () => {}),
    syncMcpRegistryToProjectBestEffort: vi.fn(async () => {})
  }
})

vi.mock('@/stores/workspace-store', () => ({
  getAllLeafPanes: (root: { type: string; children?: unknown[] }) =>
    root.type === 'leaf' ? [root] : [...(root.children ?? [])],
  findPaneContainingTab: () => null,
  agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
  browserTabId: (id: string) => `browser-${id}`,
  editorTabId: (p: string) => `edit-${p}`,
  terminalTabId: (id: string) => `term-${id}`,
  useActiveTab: () => undefined,
  useWorkspaceStore: {
    getState: () => ({
      root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
      activePaneId: 'pane-1',
      addAgentChatTab: vi.fn(),
      addBrowserTab: vi.fn(),
      removeTab: vi.fn(),
      remapAgentChatSession: vi.fn()
    })
  }
}))

vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: vi.fn(),
  getTabFocusedSessionId: vi.fn(() => null)
}))

import { useAcpStore } from './index'

const EVENT = {
  requestId: 'req-1',
  sessionId: 'sess-1',
  agentId: 'agent-1',
  action: 'navigate'
}

beforeEach(() => {
  mockBrowserConsentRespond.mockReset()
  mockLogFrontendError.mockReset()
  useAcpStore.setState({ pendingBrowserConsents: {} })
})

describe('respondBrowserConsent', () => {
  it('removes the entry optimistically and forwards the response', async () => {
    mockBrowserConsentRespond.mockResolvedValue(true)
    useAcpStore.getState()._onBrowserConsentRequest(EVENT)
    expect(useAcpStore.getState().pendingBrowserConsents['req-1']).toBeDefined()

    useAcpStore.getState().respondBrowserConsent('req-1', true)

    expect(useAcpStore.getState().pendingBrowserConsents['req-1']).toBeUndefined()
    expect(mockBrowserConsentRespond).toHaveBeenCalledWith('req-1', true)
    // Flush the .then microtask chain before asserting the warn never fires.
    await new Promise((r) => setTimeout(r, 0))
    expect(mockLogFrontendError).not.toHaveBeenCalled()
  })

  it('logs a warn when the host respond fails', async () => {
    mockBrowserConsentRespond.mockResolvedValue(false)
    useAcpStore.getState()._onBrowserConsentRequest(EVENT)

    useAcpStore.getState().respondBrowserConsent('req-1', false)

    expect(useAcpStore.getState().pendingBrowserConsents['req-1']).toBeUndefined()
    await vi.waitFor(() => expect(mockLogFrontendError).toHaveBeenCalled())
    const payload = mockLogFrontendError.mock.calls[0][0]
    expect(payload.level).toBe('warn')
    expect(payload.message).toContain('req-1')
    expect(payload.message).toContain('allowed=false')
  })
})
