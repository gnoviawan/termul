import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { WebApp } from './WebApp'

const mockConnect = vi.fn(async () => {})

vi.mock('@/lib/ws-adapter', () => ({
  createWsAdapter: () => ({
    connect: mockConnect,
    disconnect: vi.fn(),
    invoke: vi.fn(async (command: string) => {
      if (command === 'get_projects') return { projects: [], activeProjectId: null }
      if (command === 'ws_server_get_status') return { httpUrl: 'http://localhost:9876', wsUrl: 'ws://localhost:9876', clientCount: 0 }
      if (command === 'terminal_list') return []
      return undefined
    }),
    listen: vi.fn(() => () => {}),
    onDisconnect: vi.fn(() => {})
  })
}))

describe('WebApp', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn()
    })
    document.cookie = 'termul_web_lite_password=test; Path=/'
    window.open = vi.fn()
    window.crypto.randomUUID = vi.fn(() => 'uuid-uuid-uuid-uuid-uuid') as typeof window.crypto.randomUUID
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders workspace empty state after connect', () => {
    render(<WebApp />)
    return waitFor(() => {
      expect(screen.getByText('No Projects Yet')).toBeInTheDocument()
      expect(screen.getByText('No projects yet')).toBeInTheDocument()
    })
  })

  it('renders offline state when websocket connection fails', async () => {
    mockConnect.mockRejectedValueOnce(new Error('connect failed'))

    render(<WebApp />)

    await waitFor(() => {
      expect(screen.getByText('Web Lite offline')).toBeInTheDocument()
      expect(screen.getByText('connect failed')).toBeInTheDocument()
    })
  })
})
