/**
 * Browser consent tickets in the store: host tickets arriving on the
 * permission contract, optimistic answers with restore on refusal, ticket
 * closure from any surface, Stop state, and the chat-tab activation that
 * keeps a hidden consent card reachable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockAnswerBrowserConsent,
  mockLogFrontendError,
  mockToastError,
  mockAddAgentChatTab,
  mockFindPaneContainingTab,
  workspaceRootRef
} = vi.hoisted(() => ({
  mockAnswerBrowserConsent: vi.fn(),
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

vi.mock('@/lib/browser-consent-api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/browser-consent-api')>()
  return { ...actual, answerBrowserConsent: mockAnswerBrowserConsent }
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
      openAgentBrowserTab: vi.fn(),
      removeTab: vi.fn(),
      remapAgentChatSession: vi.fn()
    })
  }
}))

vi.mock('@/lib/web-tab-session', () => ({
  setTabFocusedSessionId: vi.fn(),
  getTabFocusedSessionId: vi.fn(() => null)
}))

import { useBrowserControlStore } from '@/stores/browser-control-store'
import { useAcpStore } from './index'

const TICKET_ID = 'host:3f1c0f3e-8a51-4c4e-9a52-0d0f3b1f6a10'

function permissionRequest(overrides: Record<string, unknown> = {}) {
  return {
    agentId: '',
    sessionId: 'sess-1',
    requestId: TICKET_ID,
    toolCall: { toolCallId: null, title: 'Open https://docs.example.com in the agent browser' },
    options: [
      { optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_once' },
      { optionId: 'allow_project', name: 'Always allow for this project', kind: 'allow_always' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
    ],
    _meta: {
      termul: {
        origin_kind: 'browser',
        browser: {
          origin: 'https://docs.example.com',
          targetUrl: 'https://docs.example.com/start?q=1',
          targetUrlBytes: 34,
          action: 'navigate',
          element: 'Docs link',
          profile: 'global'
        }
      }
    },
    ...overrides
  } as never
}

function arrive(overrides: Record<string, unknown> = {}): void {
  useAcpStore.getState()._onPermissionRequest(permissionRequest(overrides))
}

beforeEach(() => {
  mockAnswerBrowserConsent.mockReset()
  mockLogFrontendError.mockReset()
  mockToastError.mockReset()
  mockAddAgentChatTab.mockReset()
  mockFindPaneContainingTab.mockReset().mockReturnValue(null)
  workspaceRootRef.current = { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null }
  useAcpStore.setState({ pendingBrowserConsents: {}, pendingPermissions: {} })
  useBrowserControlStore.setState({ tabSessions: {}, stoppedSessions: {} })
})

describe('browser consent tickets on the permission contract', () => {
  it('routes a host ticket to the consent surfaces, never to the agent permission queue', () => {
    arrive()
    expect(useAcpStore.getState().pendingPermissions[TICKET_ID]).toBeUndefined()
    expect(useAcpStore.getState().pendingBrowserConsents[TICKET_ID]).toEqual({
      requestId: TICKET_ID,
      sessionId: 'sess-1',
      origin: 'https://docs.example.com',
      targetUrl: 'https://docs.example.com/start?q=1',
      targetUrlBytes: 34,
      action: 'navigate',
      element: 'Docs link',
      profile: 'global',
      options: ['allow_session', 'allow_project', 'deny']
    })
  })

  it.each([
    ['ephemeral', 'ephemeral'],
    ['shared', 'global'],
    ['unheard-of', 'global']
  ])('maps a host profile of %s to %s', (reported, expected) => {
    const request = permissionRequest() as unknown as {
      _meta: { termul: { browser: Record<string, unknown> } }
    }
    request._meta.termul.browser.profile = reported
    useAcpStore.getState()._onPermissionRequest(request as never)
    expect(useAcpStore.getState().pendingBrowserConsents[TICKET_ID]?.profile).toBe(expected)
  })

  it('keeps an agent request that claims the browser origin kind on the agent path', () => {
    arrive({ requestId: 'perm-1', agentId: 'agent-1' })
    expect(useAcpStore.getState().pendingBrowserConsents['perm-1']).toBeUndefined()
    expect(useAcpStore.getState().pendingPermissions['perm-1']).toBeDefined()
  })

  it('drops a ticket another surface settled', () => {
    arrive()
    useAcpStore.getState()._onBrowserTicketClosed({
      sessionId: 'sess-1',
      requestId: TICKET_ID,
      outcome: 'allow_session'
    })
    expect(useAcpStore.getState().pendingBrowserConsents[TICKET_ID]).toBeUndefined()
  })
})

describe('respondBrowserConsent', () => {
  it('removes the entry optimistically and forwards the chosen option', async () => {
    mockAnswerBrowserConsent.mockResolvedValue('ok')
    arrive()
    useAcpStore.getState().respondBrowserConsent(TICKET_ID, 'allow_project')
    expect(useAcpStore.getState().pendingBrowserConsents[TICKET_ID]).toBeUndefined()
    expect(mockAnswerBrowserConsent).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: TICKET_ID }),
      'allow_project',
      ''
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('restores the entry and toasts when the host refuses the answer', async () => {
    mockAnswerBrowserConsent.mockResolvedValue('refused')
    arrive()
    useAcpStore.getState().respondBrowserConsent(TICKET_ID, 'deny')
    await vi.waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockToastError).toHaveBeenCalledWith(
      'Could not send the browser consent answer. Try again.'
    )
    expect(useAcpStore.getState().pendingBrowserConsents[TICKET_ID]).toBeDefined()
    expect(mockLogFrontendError.mock.calls.at(-1)?.[0]).toMatchObject({ level: 'warn' })
  })

  it('restores the entry when the answer came before the anti-clickjack floor', async () => {
    mockAnswerBrowserConsent.mockResolvedValue('too_early')
    arrive()
    useAcpStore.getState().respondBrowserConsent(TICKET_ID, 'allow_session')
    await vi.waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        'That was too quick. Check the request, then choose again.'
      )
    )
    expect(useAcpStore.getState().pendingBrowserConsents[TICKET_ID]).toBeDefined()
  })

  it('lets a ticket answered elsewhere stay gone', async () => {
    mockAnswerBrowserConsent.mockResolvedValue('stale')
    arrive()
    useAcpStore.getState().respondBrowserConsent(TICKET_ID, 'allow_session')
    await new Promise((r) => setTimeout(r, 0))
    expect(useAcpStore.getState().pendingBrowserConsents[TICKET_ID]).toBeUndefined()
    expect(mockToastError).not.toHaveBeenCalled()
  })
})

describe('Stop state and agent tab ownership', () => {
  it('tracks which session drives a tab and whether it is stopped', () => {
    const state = useAcpStore.getState()
    state._onBrowserAgentTab({ action: 'open', tabId: 'agent-1', sessionId: 'sess-1' })
    expect(useBrowserControlStore.getState().tabSessions).toEqual({ 'agent-1': 'sess-1' })
    state._onBrowserStopChanged({ sessionId: 'sess-1', stopped: true })
    expect(useBrowserControlStore.getState().stoppedSessions).toEqual({ 'sess-1': true })
    state._onBrowserStopChanged({ sessionId: 'sess-1', stopped: false })
    expect(useBrowserControlStore.getState().stoppedSessions).toEqual({})
    state._onBrowserAgentTab({ action: 'close', tabId: 'agent-1', sessionId: 'sess-1' })
    expect(useBrowserControlStore.getState().tabSessions).toEqual({})
  })
})

describe('browser consent chat-tab activation', () => {
  it('activates the session’s chat tab when it is hidden behind another pane tab', () => {
    mockFindPaneContainingTab.mockReturnValue({ type: 'leaf', id: 'pane-1', activeTabId: 'other' })
    arrive()
    expect(useAcpStore.getState().pendingBrowserConsents[TICKET_ID]).toBeDefined()
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('sess-1')
    expect(mockLogFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', source: 'acp-store:_onBrowserConsentTicket' })
    )
  })

  it('does not re-activate when the chat tab is already the pane’s active tab', () => {
    mockFindPaneContainingTab.mockReturnValue({
      type: 'leaf',
      id: 'pane-1',
      activeTabId: 'chat-sess-1'
    })
    arrive()
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()
  })

  it('does not mint a chat tab when none is mounted (root fallback owns it)', () => {
    mockFindPaneContainingTab.mockReturnValue(null)
    arrive()
    expect(useAcpStore.getState().pendingBrowserConsents[TICKET_ID]).toBeDefined()
    expect(mockAddAgentChatTab).not.toHaveBeenCalled()
  })
})
