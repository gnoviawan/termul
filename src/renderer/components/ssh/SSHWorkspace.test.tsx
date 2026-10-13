import type { SSHProfile } from '@shared/types/ssh.types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SSH_HOSTS_TAB, type SSHSession, useSSHStore } from '@/stores/ssh-store'
import { SSHWorkspace } from './SSHWorkspace'

const { sshApi, terminalApi } = vi.hoisted(() => ({
  sshApi: {
    openSession: vi.fn(() => new Promise(() => {})),
    closeSession: vi.fn(async () => ({ success: true as const, data: undefined })),
    cancelSession: vi.fn(async () => ({ success: true as const, data: true })),
    listKeys: vi.fn(async () => ({ success: true as const, data: [] }))
  },
  terminalApi: { kill: vi.fn(async () => ({ success: true as const, data: undefined })) }
}))

vi.mock('@/lib/api', () => ({
  sshApi,
  terminalApi,
  windowApi: {
    onMaximizeChange: () => () => {},
    minimize: vi.fn(),
    toggleMaximize: vi.fn().mockResolvedValue({ success: true, data: false }),
    close: vi.fn()
  }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTauriContext: () => true
}))
vi.mock('@/components/terminal/ConnectedTerminal', () => ({
  ConnectedTerminal: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="terminal" data-pty={terminalId} />
  )
}))
vi.mock('./SSHFileEditor', () => ({ SSHFileEditor: () => <div data-testid="file-editor" /> }))
vi.mock('./SSHHostEditor', () => ({ SSHHostEditor: () => null }))

const profile: SSHProfile = {
  id: 'p1',
  name: 'prod',
  host: 'prod.example',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  portForwards: []
}

function session(id: string, overrides: Partial<SSHSession> = {}): SSHSession {
  return {
    id,
    attemptId: `attempt-${id}`,
    profileId: 'p1',
    status: 'connected',
    stage: null,
    hostKeyPrompt: null,
    credentialPrompt: null,
    error: null,
    ended: null,
    ptyId: `pty-${id}`,
    claim: 'c',
    attached: true,
    connectedAt: '2026-10-12T00:00:00Z',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  useSSHStore.setState({
    profiles: [profile],
    sessions: [],
    workspaceOpen: true,
    activeTab: SSH_HOSTS_TAB,
    selectedProfileId: null,
    pendingClose: null,
    editingFile: null
  })
})

describe('SSHWorkspace header', () => {
  it('has no drag region or window controls without topRow', () => {
    const { container } = render(<SSHWorkspace />)
    expect(container.querySelector('[data-tauri-drag-region]')).toBeNull()
    expect(screen.queryByTestId('window-controls')).toBeNull()
  })

  it('is the window top row with topRow', () => {
    const { container } = render(
      <SSHWorkspace topRow={{ dragRegion: true, windowControls: true }} />
    )
    expect(container.querySelectorAll('[data-tauri-drag-region]').length).toBeGreaterThan(0)
    expect(screen.getByTestId('window-controls')).toBeInTheDocument()
  })
})

describe('SSHWorkspace tabs', () => {
  it('starts on the Hosts tab and lists hosts', () => {
    render(<SSHWorkspace />)
    expect(screen.getByRole('tab', { name: 'Hosts' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel', { name: 'Hosts' })).toBeVisible()
    expect(screen.getByText('prod')).toBeInTheDocument()
  })

  it('opens a session tab when a host is clicked', () => {
    render(<SSHWorkspace />)
    fireEvent.click(screen.getByRole('button', { name: /Connect to prod/ }))
    const tab = screen.getByRole('tab', { name: /prod, Connecting/ })
    expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(sshApi.openSession).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'p1' }))
    expect(screen.getByTestId('ssh-connection-panel')).toHaveAttribute('data-status', 'connecting')
  })

  it('keeps every session view mounted and shows only the active one', () => {
    useSSHStore.setState({ sessions: [session('a'), session('b')], activeTab: 'b' })
    render(<SSHWorkspace />)
    const terminals = screen.getAllByTestId('terminal')
    expect(terminals.map((t) => t.dataset.pty)).toEqual(['pty-a', 'pty-b'])
    expect(screen.getByRole('tabpanel', { name: /prod \(2\)/ })).toBeVisible()
    expect(screen.getByRole('tab', { name: /prod \(1\)/ })).toHaveAttribute(
      'aria-selected',
      'false'
    )
  })

  it('moves between tabs with the arrow keys', () => {
    useSSHStore.setState({ sessions: [session('a')] })
    render(<SSHWorkspace />)
    const hosts = screen.getByRole('tab', { name: 'Hosts' })
    hosts.focus()
    fireEvent.keyDown(hosts, { key: 'ArrowRight' })
    expect(useSSHStore.getState().activeTab).toBe('a')
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /prod/ }))
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' })
    expect(useSSHStore.getState().activeTab).toBe(SSH_HOSTS_TAB)
  })

  it('asks before closing a live session and closes it on confirm', async () => {
    useSSHStore.setState({ sessions: [session('a')], activeTab: 'a' })
    render(<SSHWorkspace />)
    fireEvent.click(screen.getByRole('button', { name: 'Close prod' }))
    expect(screen.getByText('Close session?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close session' }))
    await waitFor(() => expect(sshApi.closeSession).toHaveBeenCalledWith('attempt-a'))
    expect(useSSHStore.getState().sessions).toEqual([])
    expect(useSSHStore.getState().activeTab).toBe(SSH_HOSTS_TAB)
  })

  it('closes a failed session without asking', async () => {
    useSSHStore.setState({
      sessions: [
        session('a', { status: 'failed', ptyId: null, error: { code: 'SSH_TIMEOUT', detail: 'x' } })
      ],
      activeTab: 'a'
    })
    render(<SSHWorkspace />)
    fireEvent.click(screen.getByRole('button', { name: 'Close prod' }))
    expect(screen.queryByText('Close session?')).toBeNull()
    await waitFor(() => expect(useSSHStore.getState().sessions).toEqual([]))
  })

  it('shows the kept output and a Reconnect action after the connection drops', () => {
    useSSHStore.setState({
      sessions: [
        session('a', {
          status: 'disconnected',
          ended: { reason: 'lost', exitCode: null, detail: 'Keepalive timeout' }
        })
      ],
      activeTab: 'a'
    })
    render(<SSHWorkspace />)
    const banner = screen.getByTestId('ssh-session-ended')
    expect(within(banner).getByText('Connection lost.')).toBeInTheDocument()
    expect(within(banner).getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
    expect(screen.getByTestId('terminal')).toBeInTheDocument()
  })

  it('shows the remote editor only for the session the file came from', () => {
    useSSHStore.setState({
      sessions: [session('a'), session('b')],
      activeTab: 'b',
      editingFile: {
        connectionId: 'attempt-a',
        path: '/etc/hosts',
        name: 'hosts',
        content: '',
        originalContent: ''
      }
    })
    const { rerender } = render(<SSHWorkspace />)
    expect(screen.queryByTestId('file-editor')).toBeNull()
    useSSHStore.setState({ activeTab: 'a' })
    rerender(<SSHWorkspace />)
    expect(screen.getByTestId('file-editor')).toBeInTheDocument()
  })
})
