/**
 * spec-acp-browser-pane-agent-ui + spec-acp-browser-automation-v2 (CAP-5):
 * respondBrowserConsent optimistic removal, failure restore + toast, and the
 * chat-tab activation that keeps a hidden consent card reachable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockBrowserConsentRespond,
  mockLogFrontendError,
  mockToastError,
  mockAddAgentChatTab,
  mockFindPaneContainingTab,
  workspaceRootRef
} = vi.hoisted(() => ({
  mockBrowserConsentRespond: vi.fn(),
  mockLogFrontendError: vi.fn(),
  mockToastError: vi.fn(),
  mockAddAgentChatTab: vi.fn(),
  // CAP-5 activation: what findPaneContainingTab(root, chatTabId) answers.
  mockFindPaneContainingTab: vi.fn((): unknown => null),
  workspaceRootRef: {
    current: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null } as unknown
  }
}))

vi.mock('sonner', () => ({
  toast: { error: mockToastError, warning: vi.fn(), success: vi.fn() }
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
  findPaneContainingTab: (root: unknown, tabId: string) => mockFindPaneContainingTab(root, tabId),
  agentChatTabId: (sessionId: string) => `chat-${sessionId}`,
  browserTabId: (id: string) => `browser-${id}`,
  editorTabId: (p: string) => `edit-${p}`,
  terminalTabId: (id: string) => `term-${id}`,
  useActiveTab: () => undefined,
  useWorkspaceStore: {
    getState: () => ({
      root: workspaceRootRef.current,
      activePaneId: 'pane-1',
      addAgentChatTab: mockAddAgentChatTab,
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
  mockToastError.mockReset()
  mockAddAgentChatTab.mockReset()
  mockFindPaneContainingTab.mockReset().mockReturnValue(null)
  workspaceRootRef.current = { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null }
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
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('restores the entry and toasts when the host respond fails', async () => {
    mockBrowserConsentRespond.mockResolvedValue(false)
    useAcpStore.getState()._onBrowserConsentRequest(EVENT)

    useAcpStore.getState().respondBrowserConsent('req-1', false)

    // Optimistic delete first — the restore is async (after the invoke).
    expect(useAcpStore.getState().pendingBrowserConsents['req-1']).toBeUndefined()
    await vi.waitFor(() => expect(mockLogFrontendError).toHaveBeenCalled())
    const payload = mockLogFrontendError.mock.calls[0][0]
    expect(payload.level).toBe('warn')
    expect(payload.message).toContain('req-1')
    expect(payload.message).toContain('allowed=false')
    // The failed response is retryable: the entry is back and the user is
    // told to try again.
    expect(useAcpStore.getState().pendingBrowserConsents['req-1']).toMatchObject(EVENT)
    expect(mockToastError).toHaveBeenCalledWith('Could not send the consent response. Try again.')
  })

  it('restores the entry and toasts when the respond wrapper throws', async () => {
    mockBrowserConsentRespond.mockRejectedValue(new Error('invoke exploded'))
    useAcpStore.getState()._onBrowserConsentRequest(EVENT)

    useAcpStore.getState().respondBrowserConsent('req-1', true)

    await vi.waitFor(() => expect(mockLogFrontendError).toHaveBeenCalled())
    expect(mockLogFrontendError.mock.calls[0][0].message).toContain('threw')
    expect(useAcpStore.getState().pendingBrowserConsents['req-1']).toMatchObject(EVENT)
    expect(mockToastError).toHaveBeenCalledWith('Could not send the consent response. Try again.')
  })

  it('keeps the entry restored once and never clobbers a newer request', async () => {
    // A deny re-prompt mints a NEW requestId; restoring the old entry must
    // not overwrite a newer pending consent for the same session.
    mockBrowserConsentRespond.mockResolvedValue(false)
    useAcpStore.getState()._onBrowserConsentRequest(EVENT)
    useAcpStore.getState().respondBrowserConsent('req-1', false)
    useAcpStore.getState()._onBrowserConsentRequest({ ...EVENT, requestId: 'req-2' })

    await vi.waitFor(() => expect(mockLogFrontendError).toHaveBeenCalled())
    expect(useAcpStore.getState().pendingBrowserConsents['req-2']).toBeDefined()
    expect(useAcpStore.getState().pendingBrowserConsents['req-1']).toMatchObject(EVENT)
  })
})

describe('_onBrowserConsentRequest chat-tab activation (CAP-5)', () => {
  it('activates the session’s chat tab when it is hidden behind another pane tab', () => {
    mockFindPaneContainingTab.mockReturnValue({ type: 'leaf', id: 'pane-1', activeTabId: 'other' })
    useAcpStore.getState()._onBrowserConsentRequest(EVENT)
    expect(useAcpStore.getState().pendingBrowserConsents['req-1']).toBeDefined()
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('sess-1')
    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        source: 'acp-store:_onBrowserConsentRequest'
      })
    )
  })

  it('does not re-activate when the chat tab is already the pane’s active tab', () => {
    mockFindPaneContainingTab.mockReturnValue({
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-sess-1'
    })
    useAcpStore.getState()._onBrowserConsentRequest(EVENT)
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()
    expect(mockLogFrontendError).not.toHaveBeenCalled()
  })

  it('does not mint a chat tab when none is mounted (root fallback owns it)', () => {
    mockFindPaneContainingTab.mockReturnValue(null)
    useAcpStore.getState()._onBrowserConsentRequest(EVENT)
    expect(useAcpStore.getState().pendingBrowserConsents['req-1']).toBeDefined()
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()
  })
})
