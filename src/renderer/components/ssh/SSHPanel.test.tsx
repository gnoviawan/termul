import type { SSHProfile } from '@shared/types/ssh.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SSH_HOSTS_TAB, type SSHSession, useSSHStore } from '@/stores/ssh-store'
import { SSHPanel } from './SSHPanel'

const { sshApi, terminalApi, tauriRef, toastMock } = vi.hoisted(() => ({
  sshApi: {
    listProfiles: vi.fn(),
    deleteProfile: vi.fn(),
    duplicateProfile: vi.fn(),
    importConfig: vi.fn(),
    closeSession: vi.fn(async () => ({ success: true as const, data: undefined })),
    cancelSession: vi.fn(async () => ({ success: true as const, data: true }))
  },
  terminalApi: { kill: vi.fn(async () => ({ success: true as const, data: undefined })) },
  tauriRef: { current: true },
  toastMock: { success: vi.fn(), info: vi.fn(), error: vi.fn() }
}))

// loadProfiles starts the cross-device profile sync, which watches the store.
vi.mock('@/lib/api', () => ({
  sshApi,
  terminalApi,
  persistenceApi: { watchShared: vi.fn(() => () => {}) }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
// Mutable: defaults to desktop; web tests flip it.
vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isTauriContext: () => tauriRef.current
}))
vi.mock('sonner', () => ({ toast: toastMock }))
// The editor has its own spec; the stub records which host it was opened for.
vi.mock('./SSHHostEditor', () => ({
  SSHHostEditor: ({ open, profile }: { open: boolean; profile: SSHProfile | null }) =>
    open ? <div data-testid="ssh-host-editor" data-profile-id={profile?.id ?? ''} /> : null
}))

// Stub the Radix context-menu primitives: open on `contextmenu` (unless the
// child prevented it), render items as buttons, close on select.
vi.mock('@/components/ui/context-menu', async () => {
  const React = await import('react')
  const MenuCtx = React.createContext<{ open: boolean; setOpen: (o: boolean) => void }>({
    open: false,
    setOpen: () => {}
  })
  return {
    ContextMenu: ({ children }: { children: React.ReactNode }) => {
      const [open, setOpen] = React.useState(false)
      return <MenuCtx.Provider value={{ open, setOpen }}>{children}</MenuCtx.Provider>
    },
    ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => {
      const { setOpen } = React.useContext(MenuCtx)
      const child = children as React.ReactElement<{
        onContextMenu?: (e: React.MouseEvent) => void
      }>
      return React.cloneElement(child, {
        onContextMenu: (e: React.MouseEvent) => {
          child.props.onContextMenu?.(e)
          if (e.defaultPrevented) return
          e.preventDefault()
          setOpen(true)
        }
      })
    },
    ContextMenuContent: ({ children }: { children: React.ReactNode }) => {
      const { open } = React.useContext(MenuCtx)
      return open ? <div>{children}</div> : null
    },
    ContextMenuItem: ({
      children,
      onSelect,
      variant
    }: {
      children: React.ReactNode
      onSelect?: () => void
      variant?: 'default' | 'destructive'
    }) => {
      const { setOpen } = React.useContext(MenuCtx)
      return (
        <button
          type="button"
          data-variant={variant}
          onClick={() => {
            onSelect?.()
            setOpen(false)
          }}
        >
          {children}
        </button>
      )
    },
    ContextMenuSeparator: () => <hr />
  }
})

const profile: SSHProfile = {
  id: 'p1',
  name: 'prod-box',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  portForwards: []
}

function liveSession(overrides: Partial<SSHSession> = {}): SSHSession {
  return {
    id: 'tab-1',
    attemptId: 'attempt-1',
    profileId: 'p1',
    status: 'connected',
    stage: null,
    hostKeyPrompt: null,
    credentialPrompt: null,
    error: null,
    ended: null,
    ptyId: 'pty-1',
    claim: 'claim',
    attached: true,
    connectedAt: '2026-10-12T00:00:00Z',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  tauriRef.current = true
  sshApi.listProfiles.mockResolvedValue({ success: true, data: [profile] })
  sshApi.deleteProfile.mockResolvedValue({ success: true, data: undefined })
  sshApi.importConfig.mockResolvedValue({ success: true, data: [] })
  useSSHStore.setState({
    profiles: [profile],
    sessions: [],
    workspaceOpen: false,
    activeTab: SSH_HOSTS_TAB,
    selectedProfileId: null,
    pendingClose: null,
    showAddresses: false
  })
})

describe('SSHPanel rows', () => {
  it('opens the workspace on click and connects on double-click', () => {
    const onSelectProfile = vi.fn()
    const onConnect = vi.fn()
    render(<SSHPanel onSelectProfile={onSelectProfile} onConnect={onConnect} />)
    const row = screen.getByTestId('ssh-host-row-p1')
    fireEvent.click(row)
    expect(onSelectProfile).toHaveBeenCalledWith('p1')
    fireEvent.doubleClick(row)
    expect(onConnect).toHaveBeenCalledWith('p1')
  })

  it('shows the host state from its session tabs, as a lamp and a word', () => {
    useSSHStore.setState({ sessions: [liveSession()] })
    render(<SSHPanel />)
    const row = screen.getByTestId('ssh-host-row-p1')
    expect(row.querySelector('[data-testid="ssh-host-lamp"]')).toHaveAttribute(
      'data-state',
      'connected'
    )
    expect(row).toHaveTextContent('Connected')
  })

  it('marks a host waiting for input', () => {
    useSSHStore.setState({ sessions: [liveSession({ status: 'awaitingInput', ptyId: null })] })
    render(<SSHPanel />)
    expect(screen.getByTestId('ssh-host-row-p1')).toHaveTextContent('Needs input')
  })

  it('marks the selected host with keycap', () => {
    render(<SSHPanel activeProfileId="p1" />)
    expect(screen.getByTestId('ssh-host-row-p1')).toHaveClass('keycap')
  })

  it('reveals addresses only on request (privacy)', () => {
    render(<SSHPanel />)
    expect(screen.queryByText('deploy@example.com')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Show addresses' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(screen.getByText('deploy@example.com')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAttribute('title', 'Hide addresses')
  })

  it('keeps row actions mounted with the opacity reveal (no layout shift)', () => {
    render(<SSHPanel />)
    const edit = screen.getByRole('button', { name: 'Edit prod-box' })
    expect(edit.parentElement?.className).toContain('pointer-fine:opacity-0')
    expect(screen.getByRole('button', { name: 'Connect to prod-box' })).toBeInTheDocument()
  })
})

describe('SSHPanel context menu', () => {
  it('offers Connect, Edit, Duplicate and a destructive Delete', () => {
    render(<SSHPanel />)
    fireEvent.contextMenu(screen.getByText('prod-box'))
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Duplicate' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute(
      'data-variant',
      'destructive'
    )
  })

  it('says "Open another session" when the host already has one', () => {
    useSSHStore.setState({ sessions: [liveSession()] })
    const onConnect = vi.fn()
    render(<SSHPanel onConnect={onConnect} />)
    fireEvent.contextMenu(screen.getByText('prod-box'))
    fireEvent.click(screen.getByRole('button', { name: 'Open another session' }))
    expect(onConnect).toHaveBeenCalledWith('p1')
  })

  it('omits Connect on the web client but keeps Edit and Delete', () => {
    tauriRef.current = false
    render(<SSHPanel />)
    fireEvent.contextMenu(screen.getByText('prod-box'))
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('opens the editor for the host', () => {
    render(<SSHPanel />)
    fireEvent.contextMenu(screen.getByText('prod-box'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByTestId('ssh-host-editor')).toHaveAttribute('data-profile-id', 'p1')
  })

  it('duplicates a host and reports the new name', async () => {
    sshApi.duplicateProfile.mockResolvedValue({
      success: true,
      data: { ...profile, id: 'p2', name: 'prod-box (copy)' }
    })
    render(<SSHPanel />)
    fireEvent.contextMenu(screen.getByText('prod-box'))
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith('Duplicated as “prod-box (copy)”')
    )
    expect(useSSHStore.getState().profiles.map((p) => p.id)).toEqual(['p1', 'p2'])
  })
})

describe('SSHPanel delete', () => {
  it('counts every session it will close, not only connected ones', () => {
    useSSHStore.setState({
      sessions: [
        liveSession(),
        liveSession({ id: 'tab-2', attemptId: 'attempt-2', status: 'connecting', ptyId: null })
      ]
    })
    render(<SSHPanel />)
    fireEvent.contextMenu(screen.getByText('prod-box'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText(/Its 2 sessions will be closed/)).toBeInTheDocument()
  })

  it('asks first, then closes the host sessions and deletes it', async () => {
    useSSHStore.setState({ sessions: [liveSession()] })
    render(<SSHPanel />)
    fireEvent.contextMenu(screen.getByText('prod-box'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(screen.getByText(/Its session will be closed/)).toBeInTheDocument()
    expect(sshApi.deleteProfile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(sshApi.deleteProfile).toHaveBeenCalledWith('p1'))
    expect(sshApi.closeSession).toHaveBeenCalledWith('attempt-1')
    expect(useSSHStore.getState().sessions).toEqual([])
    expect(useSSHStore.getState().profiles).toEqual([])
  })

  it('cancel leaves everything as it was', () => {
    render(<SSHPanel />)
    fireEvent.contextMenu(screen.getByText('prod-box'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(sshApi.deleteProfile).not.toHaveBeenCalled()
    expect(useSSHStore.getState().profiles).toHaveLength(1)
  })

  it('reports a failed delete', async () => {
    sshApi.deleteProfile.mockResolvedValue({ success: false, error: 'locked', code: 'X' })
    render(<SSHPanel />)
    fireEvent.contextMenu(screen.getByText('prod-box'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith('Could not delete “prod-box”. Try again.')
    )
    expect(useSSHStore.getState().profiles).toHaveLength(1)
  })
})

describe('SSHPanel empty state', () => {
  it('offers Add host and Import', async () => {
    useSSHStore.setState({ profiles: [] })
    sshApi.listProfiles.mockResolvedValue({ success: true, data: [] })
    render(<SSHPanel />)
    expect(screen.getByTestId('ssh-empty-state')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Import ~/.ssh/config' }))
    await waitFor(() => expect(sshApi.importConfig).toHaveBeenCalled())
    expect(toastMock.info).toHaveBeenCalledWith('No new hosts found in ~/.ssh/config')
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }))
    expect(screen.getByTestId('ssh-host-editor')).toHaveAttribute('data-profile-id', '')
  })

  it('hides Import on the web client', () => {
    tauriRef.current = false
    useSSHStore.setState({ profiles: [] })
    sshApi.listProfiles.mockResolvedValue({ success: true, data: [] })
    render(<SSHPanel />)
    expect(screen.queryByRole('button', { name: 'Import ~/.ssh/config' })).toBeNull()
  })
})
