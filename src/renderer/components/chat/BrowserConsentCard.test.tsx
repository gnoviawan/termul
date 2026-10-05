/**
 * spec-acp-browser-automation-v2 CAP-5 coverage:
 *  - BrowserConsentCard renders for a pending consent while the in-pane strip
 *    is NOT hosting (any non-agent-browser focus)
 *  - Allow/Deny route through respondBrowserConsent with the pending requestId
 *  - the card is suppressed while a live strip hosts the focused browser tab
 *    (mutual exclusion; strip-side integration lives in
 *    BrowserConsentStrip.test.tsx) and outside Tauri
 *  - the element intent and the sanitized aria-labelledby id
 *  - the boundary log fires once per requestId, only while hosting
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserConsentRequestEvent } from '@/lib/acp-api'
import type { WorkspaceTab } from '@/stores/workspace-store'

const { mockRespond, mockLogFrontendError, acpState, workspaceState, runtimeState } = vi.hoisted(
  () => ({
    mockRespond: vi.fn(),
    mockLogFrontendError: vi.fn(async () => {}),
    acpState: {
      pendingBrowserConsents: {} as Record<string, BrowserConsentRequestEvent>,
      configToLiveAgent: {} as Record<string, string>,
      agentConfigs: [] as Array<{ id: string; name?: string }>
    },
    workspaceState: {
      activeTab: undefined as WorkspaceTab | undefined
    },
    runtimeState: { tauri: true }
  })
)

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => runtimeState.tauri
}))

vi.mock('@/stores/acp-store', () => {
  const state = () => ({
    ...acpState,
    respondBrowserConsent: mockRespond
  })
  const useAcpStore = (sel?: (s: ReturnType<typeof state>) => unknown) =>
    sel ? sel(state()) : state()
  useAcpStore.getState = () => state()
  return { useAcpStore }
})

vi.mock('@/stores/workspace-store', () => ({
  useActiveTab: () => workspaceState.activeTab
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: mockLogFrontendError
}))

import { useConsentStripHost } from '@/stores/browser-consent-strip-store'
import { BrowserConsentCard } from './BrowserConsentCard'

const TAB_ID = 'browser-tab-1'

function consentEvent(
  overrides: Partial<BrowserConsentRequestEvent> = {}
): BrowserConsentRequestEvent {
  return {
    requestId: 'req-1',
    sessionId: 'sess-1',
    agentId: 'agent-1',
    action: 'navigate',
    ...overrides
  }
}

function browserTab(id = TAB_ID): WorkspaceTab {
  return { type: 'browser', id: `tab-${id}`, browserTabId: id } as WorkspaceTab
}

beforeEach(() => {
  mockRespond.mockReset()
  mockLogFrontendError.mockReset()
  acpState.pendingBrowserConsents = {}
  acpState.configToLiveAgent = {}
  acpState.agentConfigs = []
  workspaceState.activeTab = undefined
  runtimeState.tauri = true
  useConsentStripHost.setState({ mountedBrowserTabIds: new Set() })
})

afterEach(() => cleanup())

describe('BrowserConsentCard', () => {
  it('renders while a request is pending and the chat (non-browser) pane is focused', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = { type: 'terminal', id: 't-1', terminalId: 't-1' } as WorkspaceTab
    render(<BrowserConsentCard consent={consentEvent()} />)
    expect(screen.getByTestId('browser-consent-card')).toBeInTheDocument()
    expect(screen.getByText('Allow browser automation?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow for this session' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
  })

  it('renders with no active tab at all (non-workspace routes)', () => {
    render(<BrowserConsentCard consent={consentEvent()} />)
    expect(screen.getByTestId('browser-consent-card')).toBeInTheDocument()
  })

  it('renders when a browser tab is active but no live strip is mounted', () => {
    // Non-workspace routes / SSH mode: a browser-type activeTab persists in
    // the store with no BrowserPanel to host the strip — the card must own
    // the prompt or consent is unreachable (spec: "never both, never neither").
    workspaceState.activeTab = browserTab()
    render(<BrowserConsentCard consent={consentEvent()} />)
    expect(screen.getByTestId('browser-consent-card')).toBeInTheDocument()
  })

  it('renders nothing while a live strip hosts the focused browser tab', () => {
    useConsentStripHost.setState({ mountedBrowserTabIds: new Set([TAB_ID]) })
    workspaceState.activeTab = browserTab()
    const { container } = render(<BrowserConsentCard consent={consentEvent()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing outside Tauri (remote clients never see the prompt)', () => {
    runtimeState.tauri = false
    const { container } = render(<BrowserConsentCard consent={consentEvent()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('Allow for this session responds with the pending requestId', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    render(<BrowserConsentCard consent={consentEvent()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this session' }))
    expect(mockRespond).toHaveBeenCalledWith('req-1', true)
  })

  it('Deny responds with the pending requestId', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    render(<BrowserConsentCard consent={consentEvent()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(mockRespond).toHaveBeenCalledWith('req-1', false)
  })

  it('names the requesting agent when its live id resolves to a config', () => {
    acpState.configToLiveAgent = { 'cfg-1\0/w': 'agent-1' }
    acpState.agentConfigs = [{ id: 'cfg-1', name: 'Claude' }]
    render(<BrowserConsentCard consent={consentEvent()} />)
    expect(screen.getByText(/Claude wants to drive/)).toBeInTheDocument()
  })

  it('falls back to a generic actor when the agent id is unmapped', () => {
    render(<BrowserConsentCard consent={consentEvent()} />)
    expect(screen.getByText(/The agent wants to drive/)).toBeInTheDocument()
  })

  it('includes the element intent when the request states one', () => {
    render(<BrowserConsentCard consent={consentEvent({ element: 'Search button' })} />)
    expect(
      screen.getByText(
        /wants to drive this app's browser for this session — it wants to navigate "Search button"\./
      )
    ).toBeInTheDocument()
  })

  it('sanitizes the aria-labelledby id against hostile requestIds', () => {
    render(<BrowserConsentCard consent={consentEvent({ requestId: 'req 1!' })} />)
    const section = screen.getByTestId('browser-consent-card')
    const title = screen.getByText('Allow browser automation?')
    expect(title.id).toBe('browser-consent-title-req1')
    expect(section.getAttribute('aria-labelledby')).toBe(title.id)
  })
})

describe('BrowserConsentCard boundary log', () => {
  it('logs hosting once per requestId and not again on re-render', () => {
    const consent = consentEvent()
    const { rerender } = render(<BrowserConsentCard consent={consent} />)
    expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
    expect(mockLogFrontendError.mock.calls[0][0]).toMatchObject({
      level: 'info',
      source: 'BrowserConsentCard'
    })
    expect(mockLogFrontendError.mock.calls[0][0].message).toContain('requestId=req-1')

    rerender(<BrowserConsentCard consent={consent} />)
    expect(mockLogFrontendError).toHaveBeenCalledTimes(1)

    rerender(<BrowserConsentCard consent={consentEvent({ requestId: 'req-2' })} />)
    expect(mockLogFrontendError).toHaveBeenCalledTimes(2)
  })

  it('does not log while suppressed by a hosting strip', () => {
    useConsentStripHost.setState({ mountedBrowserTabIds: new Set([TAB_ID]) })
    workspaceState.activeTab = browserTab()
    render(<BrowserConsentCard consent={consentEvent()} />)
    expect(mockLogFrontendError).not.toHaveBeenCalled()
  })

  it('does not log outside Tauri', () => {
    runtimeState.tauri = false
    render(<BrowserConsentCard consent={consentEvent()} />)
    expect(mockLogFrontendError).not.toHaveBeenCalled()
  })
})
