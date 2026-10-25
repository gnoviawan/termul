/**
 * BrowserConsentCard: the in-chat surface for a browser consent ticket.
 *  - renders the host-supplied ticket fields while the in-pane strip is not
 *    hosting, on desktop and on remote clients
 *  - the three fixed options route through respondBrowserConsent
 *  - the answer buttons arm only after the anti-clickjack delay
 *  - the card is suppressed while a live strip hosts the focused browser tab
 *  - the boundary log fires once per requestId, only while hosting
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserConsentTicket } from '@/lib/browser-consent-api'
import type { WorkspaceTab } from '@/stores/workspace-store'

const { mockRespond, mockLogFrontendError, acpState, workspaceState, runtimeState } = vi.hoisted(
  () => ({
    mockRespond: vi.fn(),
    mockLogFrontendError: vi.fn(async () => {}),
    acpState: {
      pendingBrowserConsents: {} as Record<string, unknown>,
      sessions: {} as Record<string, { agentId: string }>,
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

import { CONSENT_ARM_DELAY_MS } from '@/components/browser/consent-intent'
import { useConsentStripHost } from '@/stores/browser-consent-strip-store'
import { BrowserConsentCard } from './BrowserConsentCard'

const TAB_ID = 'browser-tab-1'

function ticket(overrides: Partial<BrowserConsentTicket> = {}): BrowserConsentTicket {
  return {
    requestId: 'host:req-1',
    sessionId: 'sess-1',
    origin: 'https://docs.example.com',
    targetUrl: 'https://docs.example.com/start?q=1',
    targetUrlBytes: 34,
    action: 'navigate',
    profile: 'global',
    options: ['allow_session', 'allow_project', 'deny'],
    ...overrides
  }
}

function browserTab(id = TAB_ID): WorkspaceTab {
  return { type: 'browser', id: `tab-${id}`, browserTabId: id } as WorkspaceTab
}

function arm(): void {
  act(() => {
    vi.advanceTimersByTime(CONSENT_ARM_DELAY_MS)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  mockRespond.mockReset()
  mockLogFrontendError.mockReset()
  acpState.pendingBrowserConsents = {}
  acpState.sessions = {}
  acpState.configToLiveAgent = {}
  acpState.agentConfigs = []
  workspaceState.activeTab = undefined
  runtimeState.tauri = true
  useConsentStripHost.setState({ mountedBrowserTabIds: new Set() })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BrowserConsentCard', () => {
  it('shows the site, the address, the profile and the three fixed options', () => {
    workspaceState.activeTab = { type: 'terminal', id: 't-1', terminalId: 't-1' } as WorkspaceTab
    render(<BrowserConsentCard consent={ticket()} />)
    expect(screen.getByText('Allow the agent to open this site?')).toBeInTheDocument()
    expect(screen.getByText('https://docs.example.com')).toBeInTheDocument()
    expect(screen.getByText('https://docs.example.com/start?q=1')).toBeInTheDocument()
    expect(screen.getByText('Global agent profile, shared across all projects')).toBeInTheDocument()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Allow for this session',
      'Always allow for this project',
      'Deny'
    ])
  })

  it('asks about one sensitive action and offers only what the host offered', () => {
    render(
      <BrowserConsentCard
        consent={ticket({ action: 'password_submit', options: ['allow_session', 'deny'] })}
      />
    )
    expect(screen.getByText('Allow the agent to submit a password?')).toBeInTheDocument()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Allow once', 'Deny'])
  })

  it('names the project option of a sensitive action as a pre-approval for the site', () => {
    render(<BrowserConsentCard consent={ticket({ action: 'upload', profile: 'ephemeral' })} />)
    expect(screen.getByText('Allow the agent to upload a file?')).toBeInTheDocument()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Allow once',
      'Always allow on this site for this project',
      'Deny'
    ])
  })

  it('names the file an upload sends', () => {
    render(
      <BrowserConsentCard
        consent={ticket({ action: 'upload', file: { name: 'report.pdf', bytes: 9 } })}
      />
    )
    expect(screen.getByText('report.pdf (9 bytes)')).toBeInTheDocument()
  })

  it('names the ephemeral profile when the agent tab runs in it', () => {
    render(<BrowserConsentCard consent={ticket({ profile: 'ephemeral' })} />)
    expect(
      screen.getByText('Ephemeral profile, discarded when the session ends')
    ).toBeInTheDocument()
  })

  it('labels the agent-supplied intent and the shortened address', () => {
    render(
      <BrowserConsentCard
        consent={ticket({
          element: 'Search button',
          targetUrl: 'https://docs.example.com/s?token=abc…',
          targetUrlBytes: 512
        })}
      />
    )
    expect(screen.getByText('Agent says')).toBeInTheDocument()
    expect(screen.getByText('"Search button"')).toBeInTheDocument()
    expect(
      screen.getByText('https://docs.example.com/s?token=abc… (512 bytes)')
    ).toBeInTheDocument()
  })

  it('renders on a remote client, which has no browser pane', () => {
    runtimeState.tauri = false
    render(<BrowserConsentCard consent={ticket()} />)
    expect(screen.getByTestId('browser-consent-card')).toBeInTheDocument()
  })

  it('renders when a browser tab is active but no live strip is mounted', () => {
    workspaceState.activeTab = browserTab()
    render(<BrowserConsentCard consent={ticket()} />)
    expect(screen.getByTestId('browser-consent-card')).toBeInTheDocument()
  })

  it('renders nothing while a live strip hosts the focused browser tab', () => {
    useConsentStripHost.setState({ mountedBrowserTabIds: new Set([TAB_ID]) })
    workspaceState.activeTab = browserTab()
    const { container } = render(<BrowserConsentCard consent={ticket()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('keeps the answers disabled until the anti-clickjack delay passes', () => {
    render(<BrowserConsentCard consent={ticket()} />)
    const allow = screen.getByRole('button', { name: 'Allow for this session' })
    expect(allow).toBeDisabled()
    fireEvent.click(allow)
    expect(mockRespond).not.toHaveBeenCalled()
    arm()
    expect(allow).toBeEnabled()
  })

  it.each([
    ['Allow for this session', 'allow_session'],
    ['Always allow for this project', 'allow_project'],
    ['Deny', 'deny']
  ])('%s answers the ticket with %s', (label, optionId) => {
    render(<BrowserConsentCard consent={ticket()} />)
    arm()
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(mockRespond).toHaveBeenCalledWith('host:req-1', optionId)
  })

  it('names the requesting agent through the session it belongs to', () => {
    acpState.sessions = { 'sess-1': { agentId: 'agent-1' } }
    acpState.configToLiveAgent = { 'cfg-1\0/w': 'agent-1' }
    acpState.agentConfigs = [{ id: 'cfg-1', name: 'Claude' }]
    render(<BrowserConsentCard consent={ticket()} />)
    expect(
      screen.getByText(/Claude wants to open https:\/\/docs\.example\.com in the agent browser\./)
    ).toBeInTheDocument()
  })

  it('falls back to a generic actor when the agent id is unmapped', () => {
    render(<BrowserConsentCard consent={ticket()} />)
    expect(screen.getByText(/The agent wants to open/)).toBeInTheDocument()
  })

  it('sanitizes the aria-labelledby id against hostile requestIds', () => {
    render(<BrowserConsentCard consent={ticket({ requestId: 'host:req 1!' })} />)
    const section = screen.getByTestId('browser-consent-card')
    const title = screen.getByText('Allow the agent to open this site?')
    expect(title.id).toBe('browser-consent-title-hostreq1')
    expect(section.getAttribute('aria-labelledby')).toBe(title.id)
  })
})

// The logged-request record is module-wide, so each test uses its own ids.
describe('BrowserConsentCard boundary log', () => {
  it('logs hosting once per requestId and not again on re-render', () => {
    const consent = ticket({ requestId: 'host:log-1' })
    const { rerender } = render(<BrowserConsentCard consent={consent} />)
    expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
    expect(mockLogFrontendError.mock.calls[0][0]).toMatchObject({
      level: 'info',
      message: 'browser consent card hosting prompt: requestId=host:log-1',
      source: 'BrowserConsentCard'
    })
    rerender(<BrowserConsentCard consent={consent} />)
    expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
    rerender(<BrowserConsentCard consent={ticket({ requestId: 'host:log-2' })} />)
    expect(mockLogFrontendError).toHaveBeenCalledTimes(2)
  })

  it('logs once when the chat panel and the root host both show one ticket', () => {
    const consent = ticket({ requestId: 'host:log-3' })
    render(
      <>
        <BrowserConsentCard consent={consent} />
        <BrowserConsentCard consent={consent} />
      </>
    )
    expect(mockLogFrontendError).toHaveBeenCalledTimes(1)
  })

  it('does not log while suppressed by a hosting strip', () => {
    useConsentStripHost.setState({ mountedBrowserTabIds: new Set([TAB_ID]) })
    workspaceState.activeTab = browserTab()
    render(<BrowserConsentCard consent={ticket({ requestId: 'host:log-4' })} />)
    expect(mockLogFrontendError).not.toHaveBeenCalled()
  })
})
