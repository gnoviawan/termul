import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acpApi,
  MCP_OAUTH_CANCELLED,
  McpOAuthError,
  type McpOAuthStartOptions
} from '@/lib/acp-api'
import { useAcpStore } from '@/stores/acp-store'
import { McpOAuthPasteDialogHost } from './McpOAuthPasteDialog'
import { McpServersSettings } from './McpServersSettings'

const { toastError, toastSuccess, toastFn } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastFn: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: Object.assign(toastFn, { error: toastError, success: toastSuccess })
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))
vi.mock('@/lib/acp-mcp-persistence', async (orig) => ({
  ...(await orig<typeof import('@/lib/acp-mcp-persistence')>()),
  saveMcpServers: vi.fn(async () => {})
}))

const SERVER_URL = 'https://mcp.example.test/mcp'
const AUTH_URL = 'https://auth.example.test/authorize?client_id=x'
const REDIRECT_URI = 'http://127.0.0.1:8080/oauth/callback'
const PASTED = `${REDIRECT_URI}?code=c&state=s`

/** A web sign-in as the facade runs it: publishes the link, then waits until
 * the token is stored (`tokenStored`) or the signal aborts. */
function webSignIn(): { tokenStored: () => void } {
  let store: () => void = () => {}
  vi.spyOn(acpApi, 'startMcpOAuth').mockImplementation(
    (_projectId: string, _url: string, options: McpOAuthStartOptions = {}) =>
      new Promise<void>((resolve, reject) => {
        options.onAuthUrl?.(AUTH_URL, REDIRECT_URI)
        store = resolve
        options.signal?.addEventListener('abort', () =>
          reject(new McpOAuthError('OAuth sign-in cancelled', MCP_OAUTH_CANCELLED))
        )
      })
  )
  return { tokenStored: () => store() }
}

function paste(value: string): void {
  fireEvent.change(screen.getByLabelText('Paste the redirect address'), { target: { value } })
  fireEvent.click(screen.getByRole('button', { name: 'Complete sign-in' }))
}

describe('MCP OAuth paste-back dialog', () => {
  let probe: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    probe = vi
      .spyOn(acpApi, 'probeMcpServer')
      .mockResolvedValue({ status: 'authRequired', tools: [] })
    vi.spyOn(acpApi, 'hasMcpOAuthToken').mockResolvedValue(false)
    useAcpStore.setState({
      mcpServers: [{ id: 'remote', type: 'http', name: 'Remote', url: SERVER_URL, enabled: true }],
      mcpProbeStatus: { remote: 'authRequired' },
      mcpProbeError: {},
      mcpTools: {},
      mcpToolsLoaded: {},
      mcpProbing: {},
      mcpOAuthConnected: {},
      mcpOAuthConnecting: {},
      mcpOAuthPasteBack: {}
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('finishes a remote sign-in with the pasted address and reports the server connected', async () => {
    const signIn = webSignIn()
    const complete = vi.spyOn(acpApi, 'completeMcpOAuth').mockImplementation(async () => {
      signIn.tokenStored()
    })
    render(<McpOAuthPasteDialogHost />)

    let connected: boolean | undefined
    act(() => {
      void useAcpStore
        .getState()
        .connectMcpOAuth('proj-1', 'remote')
        .then((result) => {
          connected = result
        })
    })

    expect(await screen.findByText('Finish signing in to Remote')).toBeInTheDocument()
    expect(screen.getByText(AUTH_URL)).toBeInTheDocument()
    paste(PASTED)

    await waitFor(() => expect(connected).toBe(true))
    expect(complete).toHaveBeenCalledWith('proj-1', PASTED)
    expect(screen.queryByText('Finish signing in to Remote')).not.toBeInTheDocument()
    const state = useAcpStore.getState()
    expect(state.mcpOAuthConnected.remote).toBe(true)
    expect(state.mcpOAuthConnecting.remote).toBe(false)
    expect(state.mcpOAuthPasteBack).toEqual({})
    await waitFor(() => expect(probe).toHaveBeenCalled())
  })

  it('closes when a browser on the host finishes by itself', async () => {
    const signIn = webSignIn()
    render(<McpOAuthPasteDialogHost />)
    act(() => {
      void useAcpStore.getState().connectMcpOAuth('proj-1', 'remote')
    })
    expect(await screen.findByText('Finish signing in to Remote')).toBeInTheDocument()

    act(() => signIn.tokenStored())

    await waitFor(() =>
      expect(screen.queryByText('Finish signing in to Remote')).not.toBeInTheDocument()
    )
    expect(useAcpStore.getState().mcpOAuthConnected.remote).toBe(true)
  })

  it('Dismiss stops the flow, clears the spinner, and shows no toast', async () => {
    webSignIn()
    render(
      <>
        <McpServersSettings />
        <McpOAuthPasteDialogHost />
      </>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(await screen.findByText('Finish signing in to Remote')).toBeInTheDocument()
    // The modal hides the page behind it from the accessibility tree.
    expect(screen.getByRole('button', { name: 'Connecting…', hidden: true })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    await waitFor(() =>
      expect(screen.queryByText('Finish signing in to Remote')).not.toBeInTheDocument()
    )
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeEnabled()
    expect(useAcpStore.getState().mcpOAuthConnecting.remote).toBe(false)
    expect(toastError).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('refuses an address that is not a loopback redirect without calling the host', async () => {
    webSignIn()
    const complete = vi.spyOn(acpApi, 'completeMcpOAuth')
    render(<McpOAuthPasteDialogHost />)
    act(() => {
      void useAcpStore.getState().connectMcpOAuth('proj-1', 'remote')
    })
    await screen.findByText('Finish signing in to Remote')

    paste('https://evil.example/oauth/callback?code=c&state=s')

    expect(screen.getByRole('alert')).toHaveTextContent(
      `Paste the address your browser landed on. It starts with ${REDIRECT_URI}.`
    )
    expect(complete).not.toHaveBeenCalled()
  })

  it('keeps the dialog open for a retry when the host says the address does not match', async () => {
    webSignIn()
    vi.spyOn(acpApi, 'completeMcpOAuth').mockRejectedValue(
      new McpOAuthError('redirect does not match', 'OAUTH_BAD_REDIRECT')
    )
    render(<McpOAuthPasteDialogHost />)
    act(() => {
      void useAcpStore.getState().connectMcpOAuth('proj-1', 'remote')
    })
    await screen.findByText('Finish signing in to Remote')

    paste('http://127.0.0.1:9999/other?code=c&state=s')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      `That address does not belong to this sign-in. Paste the full address that starts with ${REDIRECT_URI}.`
    )
    expect(screen.getByRole('button', { name: 'Complete sign-in' })).toBeEnabled()
    expect(useAcpStore.getState().mcpOAuthPasteBack.remote).toBeDefined()
  })

  it('shows the provider error when sign-in was denied and blocks another paste', async () => {
    webSignIn()
    vi.spyOn(acpApi, 'completeMcpOAuth').mockRejectedValue(
      new McpOAuthError('The user denied access', 'OAUTH_DENIED')
    )
    render(<McpOAuthPasteDialogHost />)
    act(() => {
      void useAcpStore.getState().connectMcpOAuth('proj-1', 'remote')
    })
    await screen.findByText('Finish signing in to Remote')

    paste(`${REDIRECT_URI}?error=access_denied&state=s`)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign-in was not allowed (The user denied access). Dismiss, then press Connect to try again.'
    )
    expect(screen.getByRole('button', { name: 'Complete sign-in' })).toBeDisabled()
  })

  it('closes with a toast when the host no longer holds the flow', async () => {
    webSignIn()
    vi.spyOn(acpApi, 'completeMcpOAuth').mockRejectedValue(
      new McpOAuthError('unknown or expired sign-in', 'OAUTH_UNKNOWN_STATE')
    )
    render(<McpOAuthPasteDialogHost />)
    let connected: boolean | undefined
    act(() => {
      void useAcpStore
        .getState()
        .connectMcpOAuth('proj-1', 'remote')
        .then((result) => {
          connected = result
        })
    })
    await screen.findByText('Finish signing in to Remote')

    paste(PASTED)

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        'The sign-in to Remote expired. Press Connect to start again.'
      )
    )
    await waitFor(() => expect(connected).toBe(false))
    expect(screen.queryByText('Finish signing in to Remote')).not.toBeInTheDocument()
    expect(useAcpStore.getState().mcpOAuthConnecting.remote).toBe(false)
  })
  it('treats an unknown flow as done when the host already stored the token', async () => {
    const signIn = webSignIn()
    vi.spyOn(acpApi, 'completeMcpOAuth').mockRejectedValue(
      new McpOAuthError('unknown or expired sign-in', 'OAUTH_UNKNOWN_STATE')
    )
    const hasToken = vi.spyOn(acpApi, 'hasMcpOAuthToken').mockResolvedValue(true)
    render(<McpOAuthPasteDialogHost />)
    let connected: boolean | undefined
    act(() => {
      void useAcpStore
        .getState()
        .connectMcpOAuth('proj-1', 'remote')
        .then((result) => {
          connected = result
        })
    })
    await screen.findByText('Finish signing in to Remote')

    paste(PASTED)

    await waitFor(() =>
      expect(screen.queryByText('Finish signing in to Remote')).not.toBeInTheDocument()
    )
    expect(hasToken).toHaveBeenCalledWith('proj-1', SERVER_URL)
    expect(toastError).not.toHaveBeenCalled()
    expect(useAcpStore.getState().mcpOAuthConnecting.remote).toBe(true)

    act(() => signIn.tokenStored())

    await waitFor(() => expect(connected).toBe(true))
    expect(useAcpStore.getState().mcpOAuthConnected.remote).toBe(true)
  })

  it('deleting the server mid-sign-in stops the flow and closes the dialog', async () => {
    const start = vi.spyOn(acpApi, 'startMcpOAuth')
    webSignIn()
    render(<McpOAuthPasteDialogHost />)
    let connected: boolean | undefined
    act(() => {
      void useAcpStore
        .getState()
        .connectMcpOAuth('proj-1', 'remote')
        .then((result) => {
          connected = result
        })
    })
    await screen.findByText('Finish signing in to Remote')
    const signal = start.mock.calls[0]?.[2]?.signal

    await act(() => useAcpStore.getState().deleteMcpServer('remote'))

    await waitFor(() => expect(connected).toBe(false))
    expect(signal?.aborted).toBe(true)
    expect(screen.queryByText('Finish signing in to Remote')).not.toBeInTheDocument()
    expect(useAcpStore.getState().mcpOAuthPasteBack).toEqual({})
    expect(toastError).not.toHaveBeenCalled()
  })
})
