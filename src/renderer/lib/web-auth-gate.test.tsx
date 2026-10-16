/**
 * Web auth gate tests (issue #854): a missing/wrong token on a gated
 * `termul-server` must surface the token-entry flow instead of hanging on
 * "Loading...".
 *
 * Covers:
 * - the gate probe maps a 401/UNAUTHORIZED IpcResult → `unauthorized`
 *   (token-entry screen), success → `ok`, transport failure →
 *   `network-error` (NOT a token problem);
 * - `submitWebAuthToken` stores the token the same way the `#token=`
 *   fragment flow does (localStorage + session cache via
 *   `setWebAuthToken`) and re-probes: invalid token → `invalid` + stays
 *   `unauthorized`; valid token → `ok`;
 * - the project registry hook stays parked (no watch, no premature `isLoaded`)
 *   while gated out, and subscribes once the gate flips `ok`.
 */

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebTokenGateScreen } from '@/components/WebTokenGateScreen'
import { useProjectRegistry } from '@/hooks/use-project-registry'
import {
  _resetWebAuthGateForTesting,
  checkWebAuthGate,
  flagWebAuthUnauthorized,
  getWebAuthGateState,
  submitWebAuthToken,
  useWebAuthGate,
  useWebAuthGateOk
} from '@/lib/web-auth-gate'
import { clearWebAuthToken, getWebAuthToken } from '@/lib/web-auth-token'
import { useProjectStore } from '@/stores/project-store'

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => false
}))

// WebTokenGateScreen renders <Spinner> (framer-motion useReducedMotion) —
// mock it with the repo's standard pattern (see icon-swap.test.tsx) so the
// component suite needs no motion runtime.
vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: () => true
  }
})

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn(() => Promise.resolve())
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Unauthorized',
    json: async () => body
  } as unknown as Response
}

function unauthorized(): Response {
  return jsonResponse({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, false, 401)
}

const projectsPayload = {
  success: true,
  data: { projects: [], defaultProjectId: null }
}

describe('web auth gate (lib)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetWebAuthGateForTesting()
    clearWebAuthToken()
    window.localStorage.clear()
    window.history.replaceState({}, '', '/')
    useProjectStore.setState({ projects: [], activeProjectId: '', isLoaded: false })
  })

  afterEach(() => {
    _resetWebAuthGateForTesting()
    clearWebAuthToken()
    window.localStorage.clear()
  })

  it('resolves ok when the gated route answers success (valid or no token needed)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(projectsPayload))
    checkWebAuthGate()
    const { result } = renderHook(() => useWebAuthGate())
    await waitFor(() => expect(result.current.status).toBe('ok'))
    expect(result.current.submitting).toBe(false)
  })

  it('resolves unauthorized when the gate answers 401 UNAUTHORIZED', async () => {
    fetchMock.mockResolvedValueOnce(unauthorized())
    checkWebAuthGate()
    const { result } = renderHook(() => useWebAuthGate())
    await waitFor(() => expect(result.current.status).toBe('unauthorized'))
  })

  it('resolves network-error on transport failure (not a token problem)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('tunnel down'))
    checkWebAuthGate()
    const { result } = renderHook(() => useWebAuthGate())
    await waitFor(() => expect(result.current.status).toBe('network-error'))
  })

  it('useWebAuthGateOk is true for ok and network-error, false while unauthorized', async () => {
    const { result } = renderHook(() => useWebAuthGateOk())
    expect(result.current).toBe(false) // initial 'checking'

    fetchMock.mockResolvedValueOnce(unauthorized())
    checkWebAuthGate()
    await waitFor(() => expect(result.current).toBe(false))

    _resetWebAuthGateForTesting()
    fetchMock.mockResolvedValueOnce(jsonResponse(projectsPayload))
    checkWebAuthGate()
    await waitFor(() => expect(result.current).toBe(true))
  })

  it('does not stack probes while a check is in flight', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(projectsPayload))
    checkWebAuthGate()
    checkWebAuthGate()
    checkWebAuthGate()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('submitWebAuthToken stores the token like the fragment flow and resolves ok on acceptance', async () => {
    // Boot into unauthorized first (the token-entry screen state).
    fetchMock.mockResolvedValueOnce(unauthorized())
    checkWebAuthGate()
    await waitFor(() => expect(getWebAuthGateState().status).toBe('unauthorized'))

    // Submit a valid token: the next probe must carry it and succeed.
    fetchMock.mockImplementationOnce(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer new-token')
      return jsonResponse(projectsPayload)
    })

    const outcome = await submitWebAuthToken('new-token')

    expect(outcome).toBe('ok')
    // Same persistence as the #token= fragment flow.
    expect(getWebAuthToken()).toBe('new-token')
    expect(window.localStorage.getItem('termul.webAuthToken')).toBe('new-token')
    expect(getWebAuthGateState().status).toBe('ok')
    expect(getWebAuthGateState().submitting).toBe(false)
  })

  it('submitWebAuthToken reports invalid on a still-refused token and stays unauthorized', async () => {
    fetchMock.mockResolvedValueOnce(unauthorized())
    checkWebAuthGate()
    await waitFor(() => expect(getWebAuthGateState().status).toBe('unauthorized'))

    // The submitted token is still wrong: refused again.
    fetchMock.mockResolvedValueOnce(unauthorized())

    const outcome = await submitWebAuthToken('wrong-token')

    expect(outcome).toBe('invalid')
    expect(getWebAuthGateState().status).toBe('unauthorized')
    // The bad token is stored for the session so a corrected submit replaces
    // it — the screen keeps its input.
  })

  it('rejects an empty submission without touching the server', async () => {
    const outcome = await submitWebAuthToken('   ')
    expect(outcome).toBe('invalid')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ---- Issue #907 (F3): WS-driven unauthorized re-surface ---------------

  it('flagWebAuthUnauthorized flips a resolved-ok gate back to unauthorized without a probe', async () => {
    // Boot into ok (valid token) — a live session.
    fetchMock.mockResolvedValueOnce(jsonResponse(projectsPayload))
    checkWebAuthGate()
    await waitFor(() => expect(getWebAuthGateState().status).toBe('ok'))

    // The WS transport flags a mid-session authenticate refusal. No REST
    // probe may fire (the flag is local signal, not a fetch).
    const fetchCount = fetchMock.mock.calls.length
    flagWebAuthUnauthorized('WsAcpTransport')

    expect(getWebAuthGateState().status).toBe('unauthorized')
    expect(getWebAuthGateState().submitting).toBe(false)
    expect(fetchMock.mock.calls.length).toBe(fetchCount)
  })

  it('flagWebAuthUnauthorized lets a subsequent submit re-probe and flip back to ok', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(projectsPayload))
    checkWebAuthGate()
    await waitFor(() => expect(getWebAuthGateState().status).toBe('ok'))

    flagWebAuthUnauthorized('WsAcpTransport')
    expect(getWebAuthGateState().status).toBe('unauthorized')

    // The user submits a (fixed) token: the re-probe succeeds → ok again.
    fetchMock.mockResolvedValueOnce(jsonResponse(projectsPayload))
    const outcome = await submitWebAuthToken('fixed-token')

    expect(outcome).toBe('ok')
    expect(getWebAuthGateState().status).toBe('ok')
    expect(getWebAuthToken()).toBe('fixed-token')
  })

  it('flagWebAuthUnauthorized does not stack REST probes via checkWebAuthGate while unauthorized', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(projectsPayload))
    checkWebAuthGate()
    await waitFor(() => expect(getWebAuthGateState().status).toBe('ok'))

    flagWebAuthUnauthorized('WsAcpTransport')
    // Concurrent boot consumers re-check — the guard must hold (no probe).
    checkWebAuthGate()
    checkWebAuthGate()
    expect(getWebAuthGateState().status).toBe('unauthorized')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('WebTokenGateScreen (component)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetWebAuthGateForTesting()
    clearWebAuthToken()
    window.localStorage.clear()
  })

  afterEach(() => {
    _resetWebAuthGateForTesting()
    clearWebAuthToken()
    window.localStorage.clear()
  })

  function bootUnauthorized(): void {
    fetchMock.mockResolvedValueOnce(unauthorized())
    checkWebAuthGate()
  }

  it('renders the token entry form when the gate is unauthorized', async () => {
    bootUnauthorized()
    render(<WebTokenGateScreen />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled())
    expect(screen.getByText('Server access token required')).toBeInTheDocument()
    expect(screen.getByLabelText('Access token')).toBeInTheDocument()
  })

  it('shows "invalid token" on a wrong token, then succeeds on a valid one', async () => {
    bootUnauthorized()
    render(<WebTokenGateScreen />)
    const input = await screen.findByLabelText('Access token')
    fireEvent.change(input, { target: { value: 'wrong-token' } })

    // First submit: refused.
    fetchMock.mockResolvedValueOnce(unauthorized())
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Invalid token/i)

    // Correct the token and submit again: accepted — the alert clears.
    fireEvent.change(input, { target: { value: 'good-token' } })
    fetchMock.mockResolvedValueOnce(jsonResponse(projectsPayload))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => {
      expect(getWebAuthGateState().status).toBe('ok')
    })
    expect(getWebAuthToken()).toBe('good-token')
  })

  it('requires a non-empty token', async () => {
    bootUnauthorized()
    render(<WebTokenGateScreen />)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Enter the access token/i)
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the boot probe
  })
})

describe('useProjectRegistry gating (#854 bootstrap continuation)', () => {
  const { mockSubscribe, mockPersistenceRead } = vi.hoisted(() => ({
    mockSubscribe: vi.fn(),
    mockPersistenceRead: vi.fn()
  }))

  vi.mock('@/lib/acp-transport', () => ({
    getAcpTransport: () => ({ watches: { subscribe: mockSubscribe } })
  }))

  vi.mock('@/lib/api', () => ({
    persistenceApi: { read: mockPersistenceRead, write: vi.fn(), writeDebounced: vi.fn() },
    secureStorageApi: { getSecret: vi.fn(), setSecret: vi.fn(), deleteSecret: vi.fn() },
    terminalApi: {},
    worktreeApi: {},
    filesystemApi: {}
  }))

  /** Hand the watch a full state, as the host does on subscribe. */
  function deliverState(list: unknown): void {
    const handlers = mockSubscribe.mock.calls[0][1] as { onState: (state: unknown) => void }
    act(() => handlers.onState(list))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    _resetWebAuthGateForTesting()
    clearWebAuthToken()
    window.localStorage.clear()
    useProjectStore.setState({ projects: [], activeProjectId: '', isLoaded: false })
    mockPersistenceRead.mockResolvedValue({ success: false, code: 'KEY_NOT_FOUND', error: 'none' })
    mockSubscribe.mockReturnValue(() => {})
  })

  afterEach(() => {
    _resetWebAuthGateForTesting()
    clearWebAuthToken()
    window.localStorage.clear()
  })

  it('does not watch the projects (or flip isLoaded) while the gate is unauthorized', async () => {
    fetchMock.mockResolvedValueOnce(unauthorized())
    checkWebAuthGate()
    await waitFor(() => expect(getWebAuthGateState().status).toBe('unauthorized'))

    const { unmount } = renderHook(() => useProjectRegistry())
    // Give any (wrongly scheduled) subscription a chance to happen.
    await act(async () => {
      await Promise.resolve()
    })

    expect(mockSubscribe).not.toHaveBeenCalled()
    expect(useProjectStore.getState().isLoaded).toBe(false)
    unmount()
  })

  it('watches and flips isLoaded once the gate resolves ok after a token submission', async () => {
    fetchMock.mockResolvedValueOnce(unauthorized())
    checkWebAuthGate()
    await waitFor(() => expect(getWebAuthGateState().status).toBe('unauthorized'))

    renderHook(() => useProjectRegistry())
    await act(async () => {
      await Promise.resolve()
    })
    expect(mockSubscribe).not.toHaveBeenCalled()

    // Valid token submitted → gate flips ok → the hook (re)runs.
    fetchMock.mockResolvedValueOnce(jsonResponse(projectsPayload))
    await act(async () => {
      await submitWebAuthToken('good-token')
    })

    await waitFor(() => expect(mockSubscribe).toHaveBeenCalled())
    deliverState({ projects: [], defaultProjectId: null })
    await waitFor(() => expect(useProjectStore.getState().isLoaded).toBe(true))
  })

  it('runs immediately when the gate is already ok (ungated server)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(projectsPayload))
    checkWebAuthGate()
    await waitFor(() => expect(getWebAuthGateState().status).toBe('ok'))

    renderHook(() => useProjectRegistry())
    await waitFor(() => expect(mockSubscribe).toHaveBeenCalled())
    deliverState({ projects: [], defaultProjectId: null })
    await waitFor(() => expect(useProjectStore.getState().isLoaded).toBe(true))
  })
})
