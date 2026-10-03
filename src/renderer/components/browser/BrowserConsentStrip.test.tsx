/**
 * spec-acp-browser-pane-agent-ui coverage:
 *  - BrowserConsentStrip renders only in the focused pane's active browser tab
 *  - Allow/Deny route through respondBrowserConsent
 *  - BrowserConsentDialogHost is fallback-only (mutually exclusive with the strip)
 *  - BrowserPanel applies the agent-controlled gradient frame
 *  - index.css carries the reduced-motion override for the ring
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserConsentRequestEvent } from '@/lib/acp-api'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import type { WorkspaceTab } from '@/stores/workspace-store'

const { mockRespond, acpState, workspaceState, runtimeState } = vi.hoisted(() => ({
  mockRespond: vi.fn(),
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

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn(async () => {})
}))

// BrowserPanel's webview + title plumbing are native-side; stub them out so
// the panel renders as pure DOM under jsdom.
vi.mock('@/hooks/use-browser-webview', () => ({
  useBrowserWebview: () => ({ containerRef: { current: null } })
}))
vi.mock('@/lib/browser-api', () => ({
  onBrowserTabTitleChanged: () => ({ unlisten: () => {} })
}))
vi.mock('@/components/browser/BrowserControls', () => ({
  BrowserControls: () => null
}))

import { BrowserConsentDialogHost } from '@/components/agents/BrowserConsentDialog'
import { useConsentStripHost } from '@/stores/browser-consent-strip-store'
import { BrowserConsentStrip } from './BrowserConsentStrip'
import { BrowserPanel } from './BrowserPanel'

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
  acpState.pendingBrowserConsents = {}
  acpState.configToLiveAgent = {}
  acpState.agentConfigs = []
  workspaceState.activeTab = undefined
  runtimeState.tauri = true
  useBrowserSessionStore.setState({ tabs: new Map() })
  useConsentStripHost.setState({ mountedBrowserTabIds: new Set() })
})

afterEach(() => cleanup())

describe('BrowserConsentStrip', () => {
  it('renders in the focused pane’s active browser tab while a request is pending', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = browserTab()
    render(<BrowserConsentStrip browserTabId={TAB_ID} />)
    expect(screen.getByText('Allow browser automation?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow for this session' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
  })

  it('renders nothing when the focused pane’s active tab is not this browser tab', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = { type: 'terminal', id: 't-1', terminalId: 't-1' } as WorkspaceTab
    const { container } = render(<BrowserConsentStrip browserTabId={TAB_ID} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing in a non-focused browser pane (single host)', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = browserTab('browser-tab-2')
    const { container } = render(<BrowserConsentStrip browserTabId={TAB_ID} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing with no pending consent', () => {
    workspaceState.activeTab = browserTab()
    const { container } = render(<BrowserConsentStrip browserTabId={TAB_ID} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing outside Tauri (remote clients never see the prompt)', () => {
    runtimeState.tauri = false
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = browserTab()
    const { container } = render(<BrowserConsentStrip browserTabId={TAB_ID} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('Allow for this session responds with the pending requestId', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = browserTab()
    render(<BrowserConsentStrip browserTabId={TAB_ID} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this session' }))
    expect(mockRespond).toHaveBeenCalledWith('req-1', true)
  })

  it('Deny responds with the pending requestId', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = browserTab()
    render(<BrowserConsentStrip browserTabId={TAB_ID} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(mockRespond).toHaveBeenCalledWith('req-1', false)
  })

  it('names the requesting agent when its live id resolves to a config', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    acpState.configToLiveAgent = { 'cfg-1\0/work': 'agent-1' }
    acpState.agentConfigs = [{ id: 'cfg-1', name: 'Claude' }]
    workspaceState.activeTab = browserTab()
    render(<BrowserConsentStrip browserTabId={TAB_ID} />)
    expect(screen.getByText(/Claude wants to drive/)).toBeInTheDocument()
  })

  it('falls back to a generic actor when the agent id is unmapped', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = browserTab()
    render(<BrowserConsentStrip browserTabId={TAB_ID} />)
    expect(screen.getByText(/The agent wants to drive/)).toBeInTheDocument()
  })
})

describe('BrowserConsentDialogHost (fallback)', () => {
  it('shows the modal while a request is pending and no browser tab is active', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = { type: 'terminal', id: 't-1', terminalId: 't-1' } as WorkspaceTab
    render(<BrowserConsentDialogHost />)
    expect(screen.getByText('Allow browser automation?')).toBeInTheDocument()
  })

  it('shows the modal while a request is pending and no tab is active', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    render(<BrowserConsentDialogHost />)
    expect(screen.getByText('Allow browser automation?')).toBeInTheDocument()
  })

  it('shows the modal when a browser tab is active but no strip is mounted', () => {
    // Non-workspace routes / SSH mode: a browser-type activeTab persists in
    // the store with no BrowserPanel to host the strip — the modal must own
    // the prompt or consent is unreachable (spec: "never both, never neither").
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = browserTab()
    render(<BrowserConsentDialogHost />)
    expect(screen.getByText('Allow browser automation?')).toBeInTheDocument()
  })

  it('renders nothing while a live strip hosts the focused browser tab', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = browserTab()
    render(
      <>
        <BrowserConsentStrip browserTabId={TAB_ID} />
        <BrowserConsentDialogHost />
      </>
    )
    // Strip owns it — the alert strip is present, the modal buttons are not.
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Deny' })).toHaveLength(1)
  })

  it('renders nothing with no pending consent', () => {
    const { container } = render(<BrowserConsentDialogHost />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing outside Tauri', () => {
    runtimeState.tauri = false
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    const { container } = render(<BrowserConsentDialogHost />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('strip/modal exclusivity', () => {
  it('flips from strip to modal when focus moves off the browser tab', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = browserTab()
    const { rerender } = render(
      <>
        <BrowserConsentStrip browserTabId={TAB_ID} />
        <BrowserConsentDialogHost />
      </>
    )
    // Strip owns it — the alert strip is present, the modal buttons are not.
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Deny' })).toHaveLength(1)

    workspaceState.activeTab = { type: 'terminal', id: 't-1', terminalId: 't-1' } as WorkspaceTab
    rerender(
      <>
        <BrowserConsentStrip browserTabId={TAB_ID} />
        <BrowserConsentDialogHost />
      </>
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // Modal fallback — ConfirmDialog renders the title again.
    expect(screen.getByText('Allow browser automation?')).toBeInTheDocument()
  })

  it('flips back from modal to strip when a live strip host remounts', () => {
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = { type: 'terminal', id: 't-1', terminalId: 't-1' } as WorkspaceTab
    const { rerender } = render(<BrowserConsentDialogHost />)
    expect(screen.getByText('Allow browser automation?')).toBeInTheDocument()

    workspaceState.activeTab = browserTab()
    rerender(
      <>
        <BrowserConsentStrip browserTabId={TAB_ID} />
        <BrowserConsentDialogHost />
      </>
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Deny' })).toHaveLength(1)
  })
})

describe('BrowserPanel strip mount', () => {
  it('hosts the consent strip inside the panel while a request is pending', () => {
    useBrowserSessionStore.getState().createTab(TAB_ID, 'https://example.com')
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = browserTab()
    render(<BrowserPanel browserTabId={TAB_ID} isVisible />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow for this session' })).toBeInTheDocument()
  })

  it('mounts no strip when the pending consent belongs to another pane', () => {
    useBrowserSessionStore.getState().createTab(TAB_ID, 'https://example.com')
    acpState.pendingBrowserConsents = { 'req-1': consentEvent() }
    workspaceState.activeTab = browserTab('browser-tab-2')
    render(<BrowserPanel browserTabId={TAB_ID} isVisible />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('BrowserPanel agent border', () => {
  it('applies the gradient frame class only while the tab is agent-controlled', () => {
    useBrowserSessionStore.getState().createTab(TAB_ID, 'https://example.com')
    const { container, rerender } = render(<BrowserPanel browserTabId={TAB_ID} isVisible />)
    const root = container.firstElementChild as HTMLElement
    expect(root.className).not.toContain('termul-agent-border')

    useBrowserSessionStore.getState().setAgentControlled(TAB_ID, true)
    rerender(<BrowserPanel browserTabId={TAB_ID} isVisible />)
    expect(root.className).toContain('termul-agent-border')
    expect(root.className).toContain('p-0.5')

    useBrowserSessionStore.getState().setAgentControlled(TAB_ID, false)
    rerender(<BrowserPanel browserTabId={TAB_ID} isVisible />)
    expect(root.className).not.toContain('termul-agent-border')
  })
})

describe('agent border CSS', () => {
  const css = readFileSync(join(__dirname, '../../index.css'), 'utf8')

  it('defines the animated gradient ring', () => {
    expect(css).toContain('.termul-agent-border')
    expect(css).toContain('@keyframes termul-agent-border-pan')
    expect(css).toMatch(/\.termul-agent-border \{[^}]*animation: termul-agent-border-pan/)
  })

  it('disables the animation under prefers-reduced-motion', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.termul-agent-border \{\s*animation: none;?\s*}\s*}/
    )
  })
})
