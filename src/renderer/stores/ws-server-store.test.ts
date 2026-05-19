import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useWsServerStore } from './ws-server-store'

const {
  mockStart,
  mockStop,
  mockGetStatus,
  mockGenerateToken,
  mockRotateToken,
  mockSetActiveProject,
  mockSetProjects
} = vi.hoisted(() => ({
  mockStart: vi.fn(),
  mockStop: vi.fn(),
  mockGetStatus: vi.fn(),
  mockGenerateToken: vi.fn(),
  mockRotateToken: vi.fn(),
  mockSetActiveProject: vi.fn(),
  mockSetProjects: vi.fn()
}))

vi.mock('@/lib/ws-server-api', () => ({
  wsServerApi: {
    start: mockStart,
    stop: mockStop,
    getStatus: mockGetStatus,
    generateToken: mockGenerateToken,
    rotateToken: mockRotateToken,
    setActiveProject: mockSetActiveProject,
    setProjects: mockSetProjects
  }
}))

describe('useWsServerStore', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    useWsServerStore.setState({
      status: { isRunning: false, port: 9876, clientCount: 0, sessionId: '', activeProjectId: null, tokenTtlSecs: 900, httpUrl: '', wsUrl: '', useHttps: false },
      isLoading: false,
      error: null,
      authToken: null,
      tokenExpiry: null
    })

    mockStart.mockReset()
    mockStop.mockReset()
    mockGetStatus.mockReset()
    mockGenerateToken.mockReset()
    mockRotateToken.mockReset()
    mockSetActiveProject.mockReset()
    mockSetProjects.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts the server and stores the auth token', async () => {
    mockStart.mockResolvedValueOnce({
      success: true,
      data: { isRunning: true, port: 9876, clientCount: 0, sessionId: 'session-1', activeProjectId: 'proj-1', tokenTtlSecs: 900, httpUrl: 'http://localhost:9876', wsUrl: 'ws://localhost:9876', useHttps: false }
    })

    const result = await useWsServerStore.getState().startServer(9876, 'token', true)

    expect(result.success).toBe(true)
    expect(mockStart).toHaveBeenCalledWith(9876, 'token', true)
    expect(useWsServerStore.getState().authToken).toBe('token')
    expect(useWsServerStore.getState().tokenExpiry).toBe(1900)
    expect(useWsServerStore.getState().status.isRunning).toBe(true)
  })

  it('stops the server and clears running state', async () => {
    useWsServerStore.setState({
      status: { isRunning: true, port: 9876, clientCount: 3, sessionId: 'session-1', activeProjectId: 'proj-1', tokenTtlSecs: 900, httpUrl: 'http://localhost:9876', wsUrl: 'ws://localhost:9876', useHttps: false }
    })
    mockStop.mockResolvedValueOnce({ success: true })

    const result = await useWsServerStore.getState().stopServer()

    expect(result.success).toBe(true)
    expect(useWsServerStore.getState().status.clientCount).toBe(0)
    expect(useWsServerStore.getState().status.isRunning).toBe(false)
  })

  it('generates, rotates, and refreshes status', async () => {
    mockGenerateToken.mockResolvedValueOnce('generated-token')
    mockRotateToken.mockResolvedValueOnce({ success: true, data: { token: 'rotated-token' } })
    mockGetStatus.mockResolvedValueOnce({ isRunning: true, port: 9999, clientCount: 1, sessionId: 'session-2', activeProjectId: 'proj-2', tokenTtlSecs: 900, httpUrl: 'http://localhost:9999', wsUrl: 'ws://localhost:9999', useHttps: true })

    await expect(useWsServerStore.getState().generateToken()).resolves.toBe('generated-token')
    expect(useWsServerStore.getState().authToken).toBe('generated-token')
    expect(useWsServerStore.getState().tokenExpiry).toBe(1900)

    await expect(useWsServerStore.getState().rotateToken()).resolves.toEqual({ success: true, data: { token: 'rotated-token' } })
    expect(useWsServerStore.getState().authToken).toBe('rotated-token')

    await useWsServerStore.getState().refreshStatus()
    expect(mockGetStatus).toHaveBeenCalledTimes(1)
    expect(useWsServerStore.getState().status.port).toBe(9999)
    expect(useWsServerStore.getState().status.sessionId).toBe('session-2')
  })

  it('stores explicit auth tokens and clears errors', () => {
    useWsServerStore.setState({ error: 'boom' })
    useWsServerStore.getState().setAuthToken('manual-token', 120)
    useWsServerStore.getState().clearError()

    expect(useWsServerStore.getState().authToken).toBe('manual-token')
    expect(useWsServerStore.getState().tokenExpiry).toBe(1120)
    expect(useWsServerStore.getState().error).toBeNull()
  })
})
