/**
 * spec-acp-browser-automation-v2 CAP-5 coverage: the root-level
 * BrowserConsentCardHost is the reachability fallback for pending consents
 * that no visible chat-panel card hosts (non-workspace routes, SSH mode,
 * warm-pool sessions without a chat tab, chat tabs hidden behind another
 * tab) — and never renders while the in-pane strip is hosting.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserConsentRequestEvent } from '@/lib/acp-api'
import type { WorkspaceTab } from '@/stores/workspace-store'

const { mockRespond, mockTabHide, mockTabShow, acpState, workspaceState, runtimeState } =
  vi.hoisted(() => ({
    mockRespond: vi.fn(),
    mockTabHide: vi.fn(async () => {}),
    mockTabShow: vi.fn(async () => {}),
    acpState: {
      pendingBrowserConsents: {} as Record<string, BrowserConsentRequestEvent>,
      configToLiveAgent: {} as Record<string, string>,
      agentConfigs: [] as Array<{ id: string; name?: string }>
    },
    workspaceState: {
      activeTab: undefined as WorkspaceTab | undefined
    },
    runtimeState: { tauri: true }
  }))

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

vi.mock('@/lib/browser-api', () => ({
  browserTabHide: mockTabHide,
  browserTabShow: mockTabShow
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn(async () => {})
}))

import { useConsentCardHost } from '@/stores/browser-consent-card-store'
import { useConsentStripHost } from '@/stores/browser-consent-strip-store'
import { BrowserConsentCardHost } from './BrowserConsentCardHost'

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
  mockTabHide.mockReset()
  mockTabShow.mockReset()
  acpState.pendingBrowserConsents = {}
  acpState.configToLiveAgent = {}
  acpState.agentConfigs = []
  workspaceState.activeTab = undefined
  runtimeState.tauri = true
  useConsentCardHost.setState({ hostedSessionIds: new Set() })
  useConsentStripHost.setState({ mountedBrowserTabIds: new Set() })
})

afterEach(() => cleanup())

describe('BrowserConsentCardHost (root fallback)', () => {
  it('renders a fallback card for a pending consent with no hosted chat card', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    render(<BrowserConsentCardHost />)
    expect(screen.getByTestId('browser-consent-card-host')).toBeInTheDocument()
    expect(screen.getByTestId('browser-consent-card')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow for this session' })).toBeInTheDocument()
  })

  it('renders nothing while a chat panel hosts a visible card for the session', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    useConsentCardHost.setState({ hostedSessionIds: new Set(['sess-1']) })
    const { container } = render(<BrowserConsentCardHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders only the consents whose session is unhosted', () => {
    acpState.pendingBrowserConsents = {
      'req-1': consentEvent(),
      'req-2': consentEvent({ requestId: 'req-2', sessionId: 'sess-2' })
    }
    useConsentCardHost.setState({ hostedSessionIds: new Set(['sess-1']) })
    render(<BrowserConsentCardHost />)
    expect(screen.getAllByTestId('browser-consent-card')).toHaveLength(1)
    expect(screen.getByText(/The agent wants to drive/)).toBeInTheDocument()
  })

  it('renders nothing while the strip hosts the focused browser tab', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    useConsentStripHost.setState({ mountedBrowserTabIds: new Set([TAB_ID]) })
    workspaceState.activeTab = browserTab()
    const { container } = render(<BrowserConsentCardHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing outside Tauri', () => {
    runtimeState.tauri = false
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    const { container } = render(<BrowserConsentCardHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing with no pending consent', () => {
    const { container } = render(<BrowserConsentCardHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it('routes Allow through respondBrowserConsent', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    render(<BrowserConsentCardHost />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this session' }))
    expect(mockRespond).toHaveBeenCalledWith('req-1', true)
  })

  it('hides the focused browser webview while a fallback card is showing', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = browserTab()
    render(<BrowserConsentCardHost />)
    expect(mockTabHide).toHaveBeenCalledWith(TAB_ID)
    expect(mockTabShow).not.toHaveBeenCalled()
  })

  it('restores a hidden webview once no fallback card is showing', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = browserTab()
    const { rerender } = render(<BrowserConsentCardHost />)
    expect(mockTabHide).toHaveBeenCalledWith(TAB_ID)

    acpState.pendingBrowserConsents = {}
    rerender(<BrowserConsentCardHost />)
    expect(mockTabShow).toHaveBeenCalledWith(TAB_ID)
  })
})
