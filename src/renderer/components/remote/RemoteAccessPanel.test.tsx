import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteAccessPanel } from './RemoteAccessPanel'

const {
  mockToast,
  mockGenerateToken,
  mockStartServer,
  mockStopServer,
  mockRefreshStatus,
  mockRotateToken,
  mockStartTunnel,
  mockStopTunnel,
  mockUpsertSession,
  mockSetError,
  mockActiveProject,
  wsState,
  tunnelState,
  useWsServerStoreMock,
  useProjectStoreMock,
  useTunnelStoreMock,
  clipboardWriteText,
  mockWindowOpen,
  handlers
} = vi.hoisted(() => {
  const mockToast = {
    success: vi.fn(),
    error: vi.fn()
  }

  const mockGenerateToken = vi.fn()
  const mockStartServer = vi.fn()
  const mockStopServer = vi.fn()
  const mockRefreshStatus = vi.fn()
  const mockRotateToken = vi.fn()

  const mockStartTunnel = vi.fn()
  const mockStopTunnel = vi.fn()
  const mockUpsertSession = vi.fn()
  const mockSetError = vi.fn()

  const wsState = {
    status: { isRunning: false, port: 9876, clientCount: 0, sessionId: '', activeProjectId: null as string | null, tokenTtlSecs: 900, httpUrl: '', wsUrl: '', useHttps: false },
    isLoading: false,
    error: null as string | null,
    authToken: null as string | null,
    tokenExpiry: null as number | null,
    startServer: mockStartServer,
    stopServer: mockStopServer,
    refreshStatus: mockRefreshStatus,
    generateToken: mockGenerateToken,
    rotateToken: mockRotateToken
  }

  const tunnelState = {
    sessions: [] as Array<{ id: string; status: string; publicUrl: string | null; lastError: string | null }>,
    error: null as string | null,
    startTunnel: mockStartTunnel,
    stopTunnel: mockStopTunnel,
    upsertSession: mockUpsertSession,
    setError: mockSetError
  }

  const mockActiveProject = vi.fn(() => ({ id: 'proj-1', name: 'Project One' }))

  const useProjectStoreMock = Object.assign(
    vi.fn((selector?: (state: { projects: Array<{ id: string; name: string }>; activeProjectId: string }) => unknown) => {
      const state = { projects: [{ id: 'proj-1', name: 'Project One' }], activeProjectId: 'proj-1' }
      return selector ? selector(state) : state
    }),
    {
      getState: () => ({ projects: [{ id: 'proj-1', name: 'Project One' }], activeProjectId: 'proj-1' })
    }
  )

  const useWsServerStoreMock = Object.assign(
    vi.fn(() => wsState),
    {
      setState: vi.fn((partial: Partial<typeof wsState>) => Object.assign(wsState, partial))
    }
  )

  const useTunnelStoreMock = Object.assign(
    vi.fn((selector?: (state: typeof tunnelState) => unknown) => (selector ? selector(tunnelState) : tunnelState)),
    {
      getState: () => tunnelState,
      setState: vi.fn((partial: Partial<typeof tunnelState>) => Object.assign(tunnelState, partial))
    }
  )

  const clipboardWriteText = vi.fn().mockResolvedValue(undefined)
  const mockWindowOpen = vi.fn()
  const handlers = {
    tunnelStatus: undefined as ((event: { tunnelId: string; status: string; publicUrl?: string | null; lastError?: string | null }) => void) | undefined,
    wsStatus: undefined as ((status: typeof wsState.status) => void) | undefined
  }

  return {
    mockToast,
    mockGenerateToken,
    mockStartServer,
    mockStopServer,
    mockRefreshStatus,
    mockRotateToken,
    mockStartTunnel,
    mockStopTunnel,
    mockUpsertSession,
    mockSetError,
    mockActiveProject,
    wsState,
    tunnelState,
    useWsServerStoreMock,
    useProjectStoreMock,
    useTunnelStoreMock,
    clipboardWriteText,
    mockWindowOpen,
    handlers
  }
})

vi.mock('sonner', () => ({ toast: mockToast }))
vi.mock('@/stores/ws-server-store', () => ({ useWsServerStore: useWsServerStoreMock }))
vi.mock('@/stores/project-store', () => ({ useActiveProject: mockActiveProject, useProjectStore: useProjectStoreMock }))
vi.mock('@/stores/tunnel-store', () => ({ useTunnelStore: useTunnelStoreMock }))
vi.mock('@/lib/tunnel-api', () => ({
  tunnelApi: {
    onStatusChanged: vi.fn((callback: (event: { tunnelId: string; status: string; publicUrl?: string | null; lastError?: string | null }) => void) => {
      handlers.tunnelStatus = callback
      return () => {}
    }),
    onLog: vi.fn(() => () => {}),
    start: mockStartTunnel,
    stop: mockStopTunnel
  }
}))
vi.mock('@/lib/ws-server-api', () => ({
  wsServerApi: {
    onStatusChanged: vi.fn((callback: (status: typeof wsState.status) => void) => {
      handlers.wsStatus = callback
      return () => {}
    }),
    getAuditLog: vi.fn(),
    start: mockStartServer,
    stop: mockStopServer,
    generateToken: mockGenerateToken,
    rotateToken: mockRotateToken
  }
}))

beforeEach(() => {
  wsState.status = { isRunning: false, port: 9876, clientCount: 0, sessionId: '', activeProjectId: null, tokenTtlSecs: 900, httpUrl: '', wsUrl: '', useHttps: false }
  wsState.isLoading = false
  wsState.error = null
  wsState.authToken = null
  wsState.tokenExpiry = null

  tunnelState.sessions = []
  tunnelState.error = null

  mockToast.success.mockReset()
  mockToast.error.mockReset()
  mockGenerateToken.mockReset()
  mockStartServer.mockReset()
  mockStopServer.mockReset()
  mockRefreshStatus.mockReset()
  mockRotateToken.mockReset()
  mockStartTunnel.mockReset()
  mockStopTunnel.mockReset()
  mockUpsertSession.mockReset()
  mockSetError.mockReset()

  mockGenerateToken.mockResolvedValue('generated-token')
  mockStartServer.mockResolvedValue({ success: true, data: { isRunning: true, port: 9876, clientCount: 0, httpUrl: 'http://localhost:9876', wsUrl: 'ws://localhost:9876', useHttps: false } })
  mockStopServer.mockResolvedValue({ success: true })
  mockRotateToken.mockResolvedValue({ success: true, data: { token: 'rotated-token' } })
  mockStartTunnel.mockResolvedValue({ id: 'termul-web-tunnel', configId: 'termul-web-tunnel', status: 'running', publicUrl: 'https://example.trycloudflare.com', pid: 123, lastError: null })
  mockStopTunnel.mockResolvedValue(true)

  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWriteText },
    configurable: true
  })
  clipboardWriteText.mockClear()
  mockWindowOpen.mockClear()
  vi.spyOn(window, 'open').mockImplementation(mockWindowOpen)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RemoteAccessPanel', () => {
  it('starts the web server and tunnel with a generated token', async () => {
    render(<RemoteAccessPanel />)

    fireEvent.click(screen.getAllByRole('checkbox')[1])

    fireEvent.click(screen.getByRole('button', { name: /Start Web Server & Tunnel/i }))

    await waitFor(() => {
      expect(mockGenerateToken).toHaveBeenCalledTimes(1)
      expect(mockStartServer).toHaveBeenCalledWith(9876, 'generated-token', false)
      expect(mockStartTunnel).toHaveBeenCalledWith({
        id: 'termul-web-tunnel',
        name: 'Termul Web',
        localPort: 9876,
        autoStart: false
      })
      expect(mockToast.success).toHaveBeenCalledWith('Termul Web ready at https://example.trycloudflare.com')
    })
  })

  it('renders active tunnel controls and wires stop/open/copy actions', async () => {
    wsState.status = { isRunning: true, port: 9876, clientCount: 2, sessionId: 'session-1', activeProjectId: 'proj-1', tokenTtlSecs: 900, httpUrl: 'http://localhost:9876', wsUrl: 'ws://localhost:9876', useHttps: false }
    wsState.authToken = 'secret-token'
    wsState.tokenExpiry = 1900
    tunnelState.sessions = [{ id: 'termul-web-tunnel', status: 'running', publicUrl: 'https://example.trycloudflare.com', lastError: null }]

    render(<RemoteAccessPanel />)

    fireEvent.click(screen.getByRole('button', { name: /Open Web UI/i }))
    fireEvent.click(screen.getByText('https://example.trycloudflare.com'))
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/i }))

    await waitFor(() => {
      expect(window.open).toHaveBeenCalledWith('https://example.trycloudflare.com', '_blank')
      expect(clipboardWriteText).toHaveBeenCalledWith('https://example.trycloudflare.com')
      expect(mockStopTunnel).toHaveBeenCalledWith('termul-web-tunnel')
      expect(mockStopServer).toHaveBeenCalledTimes(1)
    })
  })

  it('syncs websocket and tunnel events into the stores', () => {
    render(<RemoteAccessPanel />)

    handlers.tunnelStatus?.({ tunnelId: 'termul-web-tunnel', status: 'running', publicUrl: 'https://example.trycloudflare.com' })
    handlers.wsStatus?.({ isRunning: true, port: 9876, clientCount: 1, sessionId: 'session-1', activeProjectId: 'proj-1', tokenTtlSecs: 900, httpUrl: 'http://localhost:9876', wsUrl: 'ws://localhost:9876', useHttps: false })

    expect(mockUpsertSession).toHaveBeenCalledWith({
      id: 'termul-web-tunnel',
      configId: 'termul-web-tunnel',
      status: 'running',
      publicUrl: 'https://example.trycloudflare.com',
      lastError: null
    })
    expect(useWsServerStoreMock.setState).toHaveBeenCalledWith({
      status: { isRunning: true, port: 9876, clientCount: 1, sessionId: 'session-1', activeProjectId: 'proj-1', tokenTtlSecs: 900, httpUrl: 'http://localhost:9876', wsUrl: 'ws://localhost:9876', useHttps: false }
    })
  })
})
