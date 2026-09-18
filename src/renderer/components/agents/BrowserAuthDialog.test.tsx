import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockDeliverAuthRedirect,
  mockOpenUrl,
  mockToastError,
  mockCompleteBrowserAuth,
  mockClearPendingBrowserOpen,
  dialogStoreState
} = vi.hoisted(() => ({
  mockDeliverAuthRedirect: vi.fn(),
  mockOpenUrl: vi.fn(async () => ({ success: true as const, data: undefined })),
  mockToastError: vi.fn(),
  mockCompleteBrowserAuth: vi.fn(),
  mockClearPendingBrowserOpen: vi.fn(),
  dialogStoreState: {
    pendingBrowserOpen: {} as Record<string, string>,
    configToLiveAgent: {} as Record<string, string>,
    agentConfigs: [] as Array<{ id: string; name: string }>
  }
}))

vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: vi.fn() }
}))

vi.mock('@/lib/acp-api', () => ({
  acpApi: { deliverAuthRedirect: mockDeliverAuthRedirect }
}))

vi.mock('@/lib/api', () => ({
  openerApi: { openUrlWithSystemBrowser: mockOpenUrl }
}))

vi.mock('@/stores/acp-store', () => {
  // Build state lazily so tests can reassign dialogStoreState fields.
  const state = () => ({
    ...dialogStoreState,
    clearPendingBrowserOpen: mockClearPendingBrowserOpen,
    completeBrowserAuth: mockCompleteBrowserAuth
  })
  const useAcpStore = (sel?: (s: ReturnType<typeof state>) => unknown) =>
    sel ? sel(state()) : state()
  useAcpStore.getState = () => state()
  return {
    useAcpStore,
    configIdFromReuseKey: (key: string) => key.split('\0')[0]
  }
})

import {
  BrowserAuthDialog,
  BrowserAuthDialogHost,
  isLoopbackAuthRedirectUrl
} from './BrowserAuthDialog'

const AUTH_URL = 'https://auth.example.com/login?state=abc123'

function renderDialog(onDismiss = vi.fn()) {
  return {
    onDismiss,
    ...render(
      <BrowserAuthDialog agentId="agent-1" agentName="Devin" url={AUTH_URL} onDismiss={onDismiss} />
    )
  }
}

describe('isLoopbackAuthRedirectUrl', () => {
  it('accepts http(s) loopback URLs', () => {
    expect(isLoopbackAuthRedirectUrl('http://127.0.0.1:8080/callback?code=x')).toBe(true)
    expect(isLoopbackAuthRedirectUrl('http://localhost:3000/cb')).toBe(true)
    expect(isLoopbackAuthRedirectUrl('http://foo.localhost/cb')).toBe(true)
    expect(isLoopbackAuthRedirectUrl('https://127.200.3.4/cb')).toBe(true)
    expect(isLoopbackAuthRedirectUrl('http://[::1]:9000/cb')).toBe(true)
    // WHATWG normalization: shorthand loopback forms parse to 127.0.0.1.
    expect(isLoopbackAuthRedirectUrl('http://127.1/cb')).toBe(true)
  })

  it('rejects non-loopback and non-http(s) input before any fetch', () => {
    expect(isLoopbackAuthRedirectUrl('http://169.254.169.254/latest/meta-data')).toBe(false)
    expect(isLoopbackAuthRedirectUrl('https://example.com/cb')).toBe(false)
    expect(isLoopbackAuthRedirectUrl('http://128.0.0.1/cb')).toBe(false)
    expect(isLoopbackAuthRedirectUrl('file:///etc/passwd')).toBe(false)
    expect(isLoopbackAuthRedirectUrl('javascript:alert(1)')).toBe(false)
    expect(isLoopbackAuthRedirectUrl('not a url')).toBe(false)
    expect(isLoopbackAuthRedirectUrl('')).toBe(false)
    // '127.999.1.1' parses as a hostname, not an IPv4 literal — it must NOT
    // be treated as loopback.
    expect(isLoopbackAuthRedirectUrl('http://127.999.1.1:8080/cb?code=x')).toBe(false)
  })
})

describe('BrowserAuthDialog', () => {
  beforeEach(() => {
    mockDeliverAuthRedirect.mockReset()
    mockOpenUrl.mockClear()
    mockToastError.mockClear()
    mockCompleteBrowserAuth.mockClear()
    mockClearPendingBrowserOpen.mockClear()
    dialogStoreState.pendingBrowserOpen = {}
    dialogStoreState.configToLiveAgent = {}
    dialogStoreState.agentConfigs = []
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the captured auth URL and opens it via the opener facade', () => {
    renderDialog()
    expect(screen.getByText(AUTH_URL)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(mockOpenUrl).toHaveBeenCalledWith(AUTH_URL)
  })

  it('copies the auth URL to the clipboard', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(AUTH_URL))
  })

  it('delivers a pasted loopback redirect with agentId + url and dismisses on success', async () => {
    mockDeliverAuthRedirect.mockResolvedValue(200)
    const { onDismiss } = renderDialog()
    fireEvent.change(screen.getByLabelText('Paste the redirect address'), {
      target: { value: '  http://127.0.0.1:54321/callback?code=xyz&state=abc  ' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Complete sign-in' }))
    await waitFor(() =>
      expect(mockDeliverAuthRedirect).toHaveBeenCalledWith(
        'agent-1',
        'http://127.0.0.1:54321/callback?code=xyz&state=abc'
      )
    )
    await waitFor(() => expect(onDismiss).toHaveBeenCalled())
    // A delivered redirect means the agent IS authenticated — the dialog
    // marks it via the store so the next createSession skips authenticate.
    expect(mockCompleteBrowserAuth).toHaveBeenCalledWith('agent-1')
  })

  it('rejects a non-loopback pasted URL without any request (SSRF guard)', async () => {
    renderDialog()
    fireEvent.change(screen.getByLabelText('Paste the redirect address'), {
      target: { value: 'http://169.254.169.254/latest/meta-data' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Complete sign-in' }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(mockDeliverAuthRedirect).not.toHaveBeenCalled()
  })

  it('keeps the dialog open when the agent listener rejects the redirect', async () => {
    mockDeliverAuthRedirect.mockResolvedValue(500)
    const { onDismiss } = renderDialog()
    fireEvent.change(screen.getByLabelText('Paste the redirect address'), {
      target: { value: 'http://localhost:9999/cb' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Complete sign-in' }))
    await waitFor(() => expect(mockDeliverAuthRedirect).toHaveBeenCalled())
    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('surfaces transport errors and keeps the dialog open', async () => {
    mockDeliverAuthRedirect.mockRejectedValue(new Error('connection refused'))
    const { onDismiss } = renderDialog()
    fireEvent.change(screen.getByLabelText('Paste the redirect address'), {
      target: { value: 'http://127.0.0.1:1/cb' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Complete sign-in' }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('connection refused'))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('dismisses via the Dismiss button', () => {
    const { onDismiss } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('shows a plain string thrown by the transport as the toast', async () => {
    // Tauri invoke rejects with plain strings, not Error objects.
    mockDeliverAuthRedirect.mockRejectedValue('connection closed')
    renderDialog()
    fireEvent.change(screen.getByLabelText('Paste the redirect address'), {
      target: { value: 'http://localhost:8080/cb?code=x' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Complete sign-in' }))
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('connection closed'))
  })
})

describe('BrowserAuthDialogHost', () => {
  it('renders a dialog per pendingBrowserOpen entry with the config name', () => {
    dialogStoreState.pendingBrowserOpen = { 'agent-1': AUTH_URL }
    dialogStoreState.configToLiveAgent = { 'cfg-1\0/work': 'agent-1' }
    dialogStoreState.agentConfigs = [{ id: 'cfg-1', name: 'Devin' }]
    render(<BrowserAuthDialogHost />)
    expect(screen.getByText('Finish signing in to Devin')).toBeInTheDocument()
    expect(screen.getByText(AUTH_URL)).toBeInTheDocument()
  })

  it('falls back to a generic name and clears the entry on dismiss', () => {
    dialogStoreState.pendingBrowserOpen = { 'agent-9': AUTH_URL }
    render(<BrowserAuthDialogHost />)
    expect(screen.getByText('Finish signing in to Agent')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(mockClearPendingBrowserOpen).toHaveBeenCalledWith('agent-9')
  })
})
