import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TunnelTabContent } from './TunnelTabContent'

const {
  mockStartTunnel,
  mockStopTunnel,
  mockClearLogs,
  mockAppendLog,
  mockUpsertSession,
  mockToast,
  tunnelState,
  projectState,
  handlers
} = vi.hoisted(() => {
  const mockStartTunnel = vi.fn()
  const mockStopTunnel = vi.fn()
  const mockClearLogs = vi.fn()
  const mockAppendLog = vi.fn()
  const mockUpsertSession = vi.fn()

  const mockToast = {
    success: vi.fn(),
    error: vi.fn()
  }

  const tunnelState = {
    sessions: [] as Array<{ id: string; status: string; publicUrl: string | null; lastError: string | null }>,
    logs: [] as Array<{ tunnelId: string; line: string; timestamp: number }>,
    stopTunnel: mockStopTunnel,
    startTunnel: mockStartTunnel,
    clearLogs: mockClearLogs,
    appendLog: mockAppendLog,
    upsertSession: mockUpsertSession
  }

  const projectState = {
    projects: [
      {
        id: 'proj-1',
        name: 'Project One',
        tunnelPresets: [
          {
            id: 'preset-1',
            name: 'Preset Tunnel',
            localPort: 4242,
            hostname: 'dev.example.com',
            cloudflareToken: 'cf-token'
          }
        ]
      }
    ],
    activeProjectId: 'proj-1'
  }

  const handlers = {
    status: undefined as ((event: { tunnelId: string; status: string; publicUrl?: string | null; lastError?: string | null }) => void) | undefined,
    log: undefined as ((event: { tunnelId: string; line: string }) => void) | undefined
  }

  return { mockStartTunnel, mockStopTunnel, mockClearLogs, mockAppendLog, mockUpsertSession, mockToast, tunnelState, projectState, handlers }
})

vi.mock('sonner', () => ({ toast: mockToast }))
vi.mock('@/stores/tunnel-store', () => ({
  useTunnelStore: Object.assign(
    (selector: (state: typeof tunnelState) => unknown) => selector(tunnelState),
    { getState: () => tunnelState }
  )
}))
vi.mock('@/stores/project-store', () => ({
  useProjectStore: Object.assign(
    (selector: (state: typeof projectState) => unknown) => selector(projectState),
    { getState: () => projectState }
  )
}))
vi.mock('@/lib/api', () => ({
  tunnelApi: {
    onStatusChanged: vi.fn((callback: (event: { tunnelId: string; status: string; publicUrl?: string | null; lastError?: string | null }) => void) => {
      handlers.status = callback
      return () => {}
    }),
    onLog: vi.fn((callback: (event: { tunnelId: string; line: string }) => void) => {
      handlers.log = callback
      return () => {}
    }),
    start: mockStartTunnel,
    stop: mockStopTunnel
  },
  openerApi: {
    openWithExternalApp: vi.fn(async () => ({ success: true }))
  }
}))
vi.mock('./CloudflaredSetupModal', () => ({
  CloudflaredSetupModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div>Setup modal</div> : <div />)
}))
vi.mock('./TunnelConfigForm', () => ({
  TunnelConfigForm: ({ name, localPort, hostname, token, disabled, onNameChange, onPortChange, onHostnameChange, onTokenChange }: Record<string, unknown>) => (
    <div>
      <div>Config form</div>
      <div data-testid="name">{String(name)}</div>
      <div data-testid="port">{String(localPort)}</div>
      <div data-testid="hostname">{String(hostname)}</div>
      <div data-testid="token">{String(token)}</div>
      <div data-testid="disabled">{String(disabled)}</div>
      <button onClick={() => (onNameChange as (value: string) => void)('Updated Tunnel')}>Set name</button>
      <button onClick={() => (onPortChange as (value: string) => void)('7777')}>Set port</button>
      <button onClick={() => (onHostnameChange as (value: string) => void)('tunnel.example.com')}>Set hostname</button>
      <button onClick={() => (onTokenChange as (value: string) => void)('updated-token')}>Set token</button>
    </div>
  )
}))
vi.mock('./TunnelLogViewer', () => ({
  TunnelLogViewer: ({ logs, onClear }: { logs: Array<{ line: string }>; onClear?: () => void }) => (
    <div>
      <div>Logs: {logs.map((log) => log.line).join(',')}</div>
      <button onClick={() => onClear?.()}>Clear logs</button>
    </div>
  )
}))

beforeEach(() => {
  tunnelState.sessions = []
  tunnelState.logs = []

  mockStartTunnel.mockReset()
  mockStopTunnel.mockReset()
  mockClearLogs.mockReset()
  mockAppendLog.mockReset()
  mockUpsertSession.mockReset()
  mockToast.success.mockReset()
  mockToast.error.mockReset()

  mockStartTunnel.mockResolvedValue({ id: 'tunnel-1', configId: 'tunnel-1', status: 'running', publicUrl: 'https://example.trycloudflare.com', pid: 123, lastError: null })
  mockStopTunnel.mockResolvedValue(true)

  handlers.status = undefined
  handlers.log = undefined
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true
  })
})

describe('TunnelTabContent', () => {
  it('prefills from project presets and starts tunnels with the selected preset values', async () => {
    render(<TunnelTabContent tunnelId="tunnel-1" isVisible={true} />)

    expect(screen.getByTestId('name')).toHaveTextContent('Preset Tunnel')
    expect(screen.getByTestId('port')).toHaveTextContent('4242')
    expect(screen.getByTestId('hostname')).toHaveTextContent('dev.example.com')
    expect(screen.getByTestId('token')).toHaveTextContent('cf-token')

    fireEvent.click(screen.getByRole('button', { name: /Start Tunnel/i }))

    await waitFor(() => {
      expect(mockStartTunnel).toHaveBeenCalledWith({
        id: 'tunnel-1',
        name: 'Preset Tunnel',
        localPort: 4242,
        hostname: 'dev.example.com',
        cloudflareToken: 'cf-token',
        projectId: 'proj-1',
        autoStart: false
      })
      expect(mockToast.success).toHaveBeenCalledWith('Tunnel started')
    })
  })

  it('shows running controls, forwards events, and stops tunnels', async () => {
    tunnelState.sessions = [{ id: 'tunnel-1', status: 'running', publicUrl: 'https://example.trycloudflare.com', lastError: null }]
    tunnelState.logs = [{ tunnelId: 'tunnel-1', line: 'booted', timestamp: 1 }]

    render(<TunnelTabContent tunnelId="tunnel-1" isVisible={true} />)

    expect(screen.getByRole('button', { name: /Open/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copy URL/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Stop/i })).toBeInTheDocument()
    expect(screen.getByText('Logs: booted')).toBeInTheDocument()

    handlers.status?.({ tunnelId: 'tunnel-1', status: 'running', publicUrl: 'https://example.trycloudflare.com', lastError: null })
    handlers.log?.({ tunnelId: 'tunnel-1', line: 'connected' })

    expect(mockUpsertSession).toHaveBeenCalledWith({
      id: 'tunnel-1',
      configId: 'tunnel-1',
      status: 'running',
      publicUrl: 'https://example.trycloudflare.com',
      lastError: null
    })
    expect(mockAppendLog).toHaveBeenCalledWith('tunnel-1', 'connected')

    fireEvent.click(screen.getByRole('button', { name: /Copy URL/i }))
    fireEvent.click(screen.getByRole('button', { name: /Open/i }))
    fireEvent.click(screen.getByRole('button', { name: /Stop/i }))

    await waitFor(() => {
      expect(mockStopTunnel).toHaveBeenCalledWith('tunnel-1')
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://example.trycloudflare.com')
    })
  })
})
