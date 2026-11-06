import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserShareView } from '@/lib/test-utils/browser-share'
import { useBrowserSessionStore } from '@/stores/browser-session-store'

const USER_TAB = 'tab-0a1b2c3d-1111-4222-8333-444455556666'
const AGENT_TAB = 'agent-tab-1'

const { create, revoke, runtime, acpState, armed, logs } = vi.hoisted(() => ({
  create: vi.fn(),
  revoke: vi.fn(),
  runtime: { tauri: true },
  acpState: {
    activeSessionId: 'sess-1' as string | null,
    sessions: {} as Record<
      string,
      { id: string; agentId: string; status: string; title: string | null }
    >,
    configToLiveAgent: { 'claude::/w': 'live-claude' } as Record<string, string>,
    agentConfigs: [{ id: 'claude', name: 'Claude' }]
  },
  armed: { value: true },
  logs: [] as Array<{ message: string }>
}))

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => runtime.tauri }))
vi.mock('@/lib/browser-share-api', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/browser-share-api')>()),
  browserShareCreate: (req: unknown) => create(req),
  browserShareRevoke: (id: string) => revoke(id),
  browserShareList: async () => ({ success: true, data: [] }),
  onBrowserShareChanged: () => () => {}
}))
vi.mock('@/stores/acp-store', () => {
  const useAcpStore = (sel: (s: typeof acpState) => unknown) => sel(acpState)
  useAcpStore.getState = () => acpState
  return { useAcpStore }
})
vi.mock('@/stores/acp-reuse-keys', () => ({
  configIdFromReuseKey: (k: string) => k.split('::')[0]
}))
vi.mock('@/components/browser/consent-intent', async (importActual) => ({
  ...(await importActual<typeof import('@/components/browser/consent-intent')>()),
  useConsentArmed: () => armed.value
}))
vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn(async (p: { message: string }) => {
    logs.push(p)
  })
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { useBrowserShareStore } from '@/stores/browser-share-store'
import { BrowserShareButton, BrowserShareStrip } from './BrowserShareStrip'

function setTabUrl(tabId: string, url: string): void {
  useBrowserSessionStore.setState({
    tabs: new Map([[tabId, { url, loading: false, agentControlled: false } as never]])
  })
}

function renderPane(tabId = USER_TAB) {
  return render(
    <TooltipProvider>
      <BrowserShareButton browserTabId={tabId} />
      <BrowserShareStrip browserTabId={tabId} />
    </TooltipProvider>
  )
}

function shareButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Share to chat' }) as HTMLButtonElement
}

beforeEach(() => {
  create.mockReset()
  revoke.mockReset()
  runtime.tauri = true
  armed.value = true
  logs.length = 0
  acpState.activeSessionId = 'sess-1'
  acpState.sessions = {
    'sess-1': { id: 'sess-1', agentId: 'live-claude', status: 'active', title: 'Fix login' }
  }
  useBrowserShareStore.setState({ shares: {}, pending: {}, revoking: {}, consentTabId: null })
  setTabUrl(USER_TAB, 'https://app.example.com/login?token=secret#frag')
})

afterEach(cleanup)

describe('BrowserShareButton', () => {
  it('is absent on agent tabs and outside the desktop app', () => {
    const { container, unmount } = renderPane(AGENT_TAB)
    expect(container).toBeEmptyDOMElement()
    unmount()
    runtime.tauri = false
    expect(renderPane().container).toBeEmptyDOMElement()
  })

  it('opens the consent strip without sharing anything', () => {
    renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Share this page to chat' }))
    expect(screen.getByRole('region', { name: 'Share this page to chat' })).toBeInTheDocument()
    expect(create).not.toHaveBeenCalled()
  })
})

describe('BrowserShareStrip consent', () => {
  function open(): void {
    renderPane()
    act(() => useBrowserShareStore.getState().openConsent(USER_TAB))
  }

  it('shows only the origin, never path, query or fragment', () => {
    open()
    expect(screen.getByText('https://app.example.com')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('token=secret')
    expect(document.body.textContent).not.toContain('/login')
    expect(screen.getByText('With Claude · Fix login')).toBeInTheDocument()
  })

  it('defaults to page content only, offers screenshot, and offers no console or network scope', () => {
    open()
    expect(screen.getByRole('checkbox', { name: /Page content/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Screenshot/ })).not.toBeChecked()
    expect(screen.queryByRole('checkbox', { name: /Console errors/ })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /Failed requests/ })).toBeNull()
  })

  it('warns about sensitive data only when the screenshot scope is on', () => {
    open()
    expect(screen.queryByText(/including personal or secret data/)).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: /Screenshot/ }))
    expect(screen.getByText(/including personal or secret data/)).toBeInTheDocument()
  })

  it('stays disabled until armed, with no chat, or with no scope', () => {
    armed.value = false
    open()
    expect(shareButton()).toBeDisabled()
    cleanup()

    armed.value = true
    acpState.activeSessionId = null
    open()
    expect(screen.getByText(/Open a chat first/)).toBeInTheDocument()
    expect(shareButton()).toBeDisabled()
    cleanup()

    acpState.activeSessionId = 'sess-1'
    open()
    fireEvent.click(screen.getByRole('checkbox', { name: /Page content/ }))
    expect(shareButton()).toBeDisabled()
  })

  it('refuses to share a non-web page', () => {
    setTabUrl(USER_TAB, 'about:blank')
    open()
    expect(screen.getByText('This page cannot be shared')).toBeInTheDocument()
    expect(shareButton()).toBeDisabled()
  })

  it('requests the selected scopes for the active chat and the shown origin', async () => {
    create.mockResolvedValue({ success: true, data: browserShareView({ tabId: USER_TAB }) })
    open()
    fireEvent.click(screen.getByRole('checkbox', { name: /Screenshot/ }))
    await act(async () => fireEvent.click(shareButton()))
    expect(create).toHaveBeenCalledWith({
      tabId: USER_TAB,
      sessionId: 'sess-1',
      scopes: ['content', 'screenshot'],
      expectedOrigin: 'https://app.example.com'
    })
    const state = useBrowserShareStore.getState()
    expect(state.pending['host-share-1']).toBe(true)
    expect(state.consentTabId).toBeNull()
    expect(screen.getByRole('region', { name: 'Shared with chat' })).toBeInTheDocument()
    const logged = JSON.stringify(logs)
    expect(logged).not.toContain('example.com')
    expect(logged).not.toContain('host-share-1')
  })

  it('shows a concise error and keeps the strip open when the host refuses', async () => {
    create.mockResolvedValue({ success: false, code: 'ORIGIN_CHANGED' })
    open()
    await act(async () => fireEvent.click(shareButton()))
    expect(screen.getByRole('alert')).toHaveTextContent(/changed to another site/)
    expect(useBrowserShareStore.getState().shares).toEqual({})
    expect(JSON.stringify(logs)).toContain('code=ORIGIN_CHANGED')
  })

  it('cancel closes without sharing', () => {
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('region', { name: 'Share this page to chat' })).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })
})

describe('BrowserShareStrip indicator', () => {
  it('lists every live scope of this tab and stops all in one action', async () => {
    revoke.mockResolvedValue({ success: true, data: undefined })
    const store = useBrowserShareStore.getState()
    store.upsert(browserShareView({ tabId: USER_TAB, scopes: ['content'] }))
    store.upsert(browserShareView({ shareId: 'two', tabId: USER_TAB, scopes: ['screenshot'] }))
    store.upsert(browserShareView({ shareId: 'other-tab', tabId: 'tab-x' }))
    renderPane()
    const region = screen.getByRole('region', { name: 'Shared with chat' })
    expect(region).toHaveTextContent('Page content · Screenshot')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' })))
    expect(revoke.mock.calls.map((c) => c[0]).sort()).toEqual(['host-share-1', 'two'])
    expect(Object.keys(useBrowserShareStore.getState().shares)).toEqual(['other-tab'])
    expect(screen.queryByRole('region', { name: 'Shared with chat' })).toBeNull()
  })

  it('keeps the indicator and says so when stop fails', async () => {
    revoke.mockResolvedValue({ success: false, code: 'FAILED' })
    useBrowserShareStore.getState().upsert(browserShareView({ tabId: USER_TAB }))
    renderPane()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' })))
    expect(screen.getByRole('region', { name: 'Shared with chat' })).toHaveTextContent(
      'Could not stop'
    )
  })
})
