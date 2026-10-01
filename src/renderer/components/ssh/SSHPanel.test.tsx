import type { SSHConnection, SSHProfile } from '@shared/types/ssh.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SSHPanel } from './SSHPanel'

const {
  mockLoadProfiles,
  mockDisconnect,
  mockImportConfig,
  mockDeleteProfile,
  mockSelectProfile,
  mockToastError,
  profilesRef,
  connectionsRef,
  tauriRef
} = vi.hoisted(() => ({
  mockLoadProfiles: vi.fn(),
  mockDisconnect: vi.fn(),
  mockImportConfig: vi.fn(),
  mockDeleteProfile: vi.fn(),
  mockSelectProfile: vi.fn(),
  mockToastError: vi.fn(),
  profilesRef: { current: [] as SSHProfile[] },
  connectionsRef: { current: [] as SSHConnection[] },
  tauriRef: { current: true }
}))

vi.mock('@/stores/ssh-store', () => ({
  useSSHProfiles: () => profilesRef.current,
  useSSHConnections: () => connectionsRef.current,
  useSSHActions: () => ({
    loadProfiles: mockLoadProfiles,
    disconnect: mockDisconnect,
    importConfig: mockImportConfig,
    deleteProfile: mockDeleteProfile,
    selectProfile: mockSelectProfile
  })
}))

// Mutable: defaults to desktop. Web-mode tests flip this to verify the
// Connect/Disconnect context-menu items are absent outside Tauri.
vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => tauriRef.current
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: mockToastError }
}))

// The profile form is outside this spec's scope — stub it so the delete/menu
// tests don't pull in its dependency tree. The stub captures the profile prop
// so tests can assert the clicked profile is handed to the edit form.
vi.mock('./SSHProfileForm', () => ({
  SSHProfileForm: ({ profile }: { profile: SSHProfile | null }) => (
    <div data-testid="ssh-profile-form" data-profile-id={profile?.id ?? ''} />
  )
}))

// Stub the Radix context-menu primitives. The panel renders one menu per row;
// the stateful stub opens the menu on `contextmenu` (only if the child's
// onContextMenu did not call preventDefault — mirrors Radix's
// composeEventHandlers({ checkForDefaultPrevented: true }) so F1-type
// regressions surface), renders `<ContextMenuContent>` only while open, closes
// on Escape, and surfaces `<ContextMenuItem>` as a `<button>` so tests can
// assert presence + click wiring. Mirrors the ProjectChatList /
// ProjectSidebar stub pattern.
vi.mock('@/components/ui/context-menu', async () => {
  const React = await import('react')
  const MenuCtx = React.createContext<{ open: boolean; setOpen: (o: boolean) => void }>({
    open: false,
    setOpen: () => {}
  })
  return {
    ContextMenu: ({ children }: { children: React.ReactNode }) => {
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
          if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open])
      return <MenuCtx.Provider value={{ open, setOpen }}>{children}</MenuCtx.Provider>
    },
    ContextMenuTrigger: ({
      children,
      asChild
    }: {
      children: React.ReactNode
      asChild?: boolean
    }) => {
      const { setOpen } = React.useContext(MenuCtx)
      const merged = (e: React.MouseEvent) => {
        // F2: mirror Radix checkForDefaultPrevented — skip open if the child
        // handler called preventDefault.
        if (e.defaultPrevented) return
        e.preventDefault()
        setOpen(true)
      }
      if (asChild && React.isValidElement(children)) {
        const child = children as React.ReactElement<{
          onContextMenu?: (e: React.MouseEvent) => void
        }>
        return React.cloneElement(child, {
          onContextMenu: (e: React.MouseEvent) => {
            child.props.onContextMenu?.(e)
            merged(e)
          }
        })
      }
      return <div onContextMenu={merged}>{children}</div>
    },
    ContextMenuContent: ({ children }: { children: React.ReactNode }) => {
      const { open } = React.useContext(MenuCtx)
      if (!open) return null
      return <div>{children}</div>
    },
    ContextMenuItem: ({
      children,
      disabled,
      onSelect,
      variant
    }: {
      children: React.ReactNode
      disabled?: boolean
      onSelect?: () => void
      variant?: 'default' | 'destructive'
    }) => {
      const { setOpen } = React.useContext(MenuCtx)
      return (
        <button
          type="button"
          disabled={disabled}
          data-variant={variant}
          onClick={() => {
            if (disabled) return
            onSelect?.()
            // Radix closes the menu when an item is selected.
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

const connectedConnection: SSHConnection = {
  id: 'conn-1',
  profileId: 'p1',
  status: 'connected',
  activeForwards: [],
  reconnectAttempts: 0
}

function renderPanel(
  props: { activeProfileId?: string | null; onConnect?: (profileId: string) => Promise<void> } = {}
) {
  return render(
    <SSHPanel activeProfileId={props.activeProfileId ?? null} onConnect={props.onConnect} />
  )
}

describe('SSHPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadProfiles.mockResolvedValue(undefined)
    mockDisconnect.mockResolvedValue(true)
    mockImportConfig.mockResolvedValue([])
    mockDeleteProfile.mockResolvedValue(true)
    profilesRef.current = [profile]
    connectionsRef.current = []
    tauriRef.current = true
  })

  describe('context menu', () => {
    it('opens on right-click with Edit Profile / Connect / destructive Delete Profile (desktop, disconnected)', () => {
      renderPanel()
      fireEvent.contextMenu(screen.getByText('prod-box'))

      expect(screen.getByText('Edit Profile')).toBeInTheDocument()
      expect(screen.getByText('Connect')).toBeInTheDocument()
      expect(screen.queryByText('Disconnect')).not.toBeInTheDocument()
      const deleteItem = screen.getByText('Delete Profile')
      expect(deleteItem.closest('button')).toHaveAttribute('data-variant', 'destructive')
    })

    it('offers Disconnect instead of Connect when the profile is connected', () => {
      connectionsRef.current = [connectedConnection]
      renderPanel()
      fireEvent.contextMenu(screen.getByText('prod-box'))

      expect(screen.getByText('Disconnect')).toBeInTheDocument()
      expect(screen.queryByText('Connect')).not.toBeInTheDocument()
    })

    it('omits Connect/Disconnect on the web client but keeps Edit/Delete', () => {
      tauriRef.current = false
      renderPanel()
      fireEvent.contextMenu(screen.getByText('prod-box'))

      expect(screen.queryByText('Connect')).not.toBeInTheDocument()
      expect(screen.queryByText('Disconnect')).not.toBeInTheDocument()
      expect(screen.getByText('Edit Profile')).toBeInTheDocument()
      expect(screen.getByText('Delete Profile')).toBeInTheDocument()
    })

    it('opens the profile form in edit mode via Edit Profile', () => {
      renderPanel()
      fireEvent.contextMenu(screen.getByText('prod-box'))
      fireEvent.click(screen.getByText('Edit Profile'))

      expect(screen.getByTestId('ssh-profile-form')).toBeInTheDocument()
      // The clicked profile must be the one handed to the edit form.
      expect(screen.getByTestId('ssh-profile-form')).toHaveAttribute('data-profile-id', 'p1')
    })
    it('disables Connect and Delete while a connect for that profile is in flight', () => {
      renderPanel({ onConnect: () => new Promise<void>(() => {}) })
      // Kick off a connect via the row button so connectingId stays set.
      fireEvent.click(screen.getByTitle('Connect'))
      fireEvent.contextMenu(screen.getByText('prod-box'))

      expect(screen.getByText('Connect').closest('button')).toBeDisabled()
      expect(screen.getByText('Delete Profile').closest('button')).toBeDisabled()
    })

    it('disables Connect while the connection is reconnecting (live/pending connection)', () => {
      connectionsRef.current = [{ ...connectedConnection, status: 'reconnecting' }]
      renderPanel()
      fireEvent.contextMenu(screen.getByText('prod-box'))

      expect(screen.getByText('Connect').closest('button')).toBeDisabled()
      // No local connect in flight — delete stays available.
      expect(screen.getByText('Delete Profile').closest('button')).not.toBeDisabled()
    })

    it('disconnects a connected profile via the Disconnect menu item', async () => {
      connectionsRef.current = [connectedConnection]
      renderPanel()
      fireEvent.contextMenu(screen.getByText('prod-box'))
      fireEvent.click(screen.getByText('Disconnect'))

      await waitFor(() => expect(mockDisconnect).toHaveBeenCalledWith('conn-1'))
    })
  })

  describe('delete flow', () => {
    it('gates delete behind a confirmation dialog', () => {
      renderPanel()
      fireEvent.contextMenu(screen.getByText('prod-box'))
      fireEvent.click(screen.getByText('Delete Profile'))

      expect(screen.getByText('Delete SSH profile')).toBeInTheDocument()
      expect(
        screen.getByText('Delete “prod-box”? This action cannot be undone.')
      ).toBeInTheDocument()
      expect(mockDeleteProfile).not.toHaveBeenCalled()
    })

    it('disconnects before deleting and clears the active selection only after the delete succeeds (connected active profile)', async () => {
      connectionsRef.current = [connectedConnection]
      renderPanel({ activeProfileId: 'p1' })
      fireEvent.contextMenu(screen.getByText('prod-box'))
      fireEvent.click(screen.getByText('Delete Profile'))
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

      await waitFor(() => expect(mockDeleteProfile).toHaveBeenCalledWith('p1'))
      expect(mockDisconnect).toHaveBeenCalledWith('conn-1')
      expect(mockSelectProfile).toHaveBeenCalledWith(null)
      // disconnect must be awaited before deleteProfile runs.
      expect(mockDisconnect.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteProfile.mock.invocationCallOrder[0]
      )
      // Selection is cleared only after the delete succeeded.
      expect(mockDeleteProfile.mock.invocationCallOrder[0]).toBeLessThan(
        mockSelectProfile.mock.invocationCallOrder[0]
      )
    })

    it('deletes a non-active profile without touching the selection', async () => {
      renderPanel({ activeProfileId: 'other-profile' })
      fireEvent.contextMenu(screen.getByText('prod-box'))
      fireEvent.click(screen.getByText('Delete Profile'))
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

      await waitFor(() => expect(mockDeleteProfile).toHaveBeenCalledWith('p1'))
      expect(mockDisconnect).not.toHaveBeenCalled()
      expect(mockSelectProfile).not.toHaveBeenCalled()
    })

    it('cancel leaves the profile untouched (no store calls)', async () => {
      renderPanel({ activeProfileId: 'p1' })
      fireEvent.contextMenu(screen.getByText('prod-box'))
      fireEvent.click(screen.getByText('Delete Profile'))
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(mockDeleteProfile).not.toHaveBeenCalled()
      expect(mockDisconnect).not.toHaveBeenCalled()
      expect(mockSelectProfile).not.toHaveBeenCalled()
      await waitFor(() => expect(screen.queryByText('Delete SSH profile')).not.toBeInTheDocument())
    })

    it('surfaces a toast error when deleteProfile fails', async () => {
      mockDeleteProfile.mockResolvedValue(false)
      renderPanel({ activeProfileId: 'p1' })
      fireEvent.contextMenu(screen.getByText('prod-box'))
      fireEvent.click(screen.getByText('Delete Profile'))
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

      await waitFor(() => expect(mockToastError).toHaveBeenCalled())
      // A failed delete must not strand the user on an unselected live profile.
      expect(mockSelectProfile).not.toHaveBeenCalled()
    })

    it('aborts the delete when disconnect fails (no delete, no selection clear, error toast)', async () => {
      mockDisconnect.mockResolvedValue(false)
      connectionsRef.current = [connectedConnection]
      renderPanel({ activeProfileId: 'p1' })
      fireEvent.contextMenu(screen.getByText('prod-box'))
      fireEvent.click(screen.getByText('Delete Profile'))
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

      await waitFor(() => expect(mockToastError).toHaveBeenCalled())
      expect(mockDisconnect).toHaveBeenCalledWith('conn-1')
      expect(mockDeleteProfile).not.toHaveBeenCalled()
      expect(mockSelectProfile).not.toHaveBeenCalled()
    })

    it('surfaces a toast error when a store action throws (no unhandled rejection)', async () => {
      mockDeleteProfile.mockRejectedValue(new Error('boom'))
      renderPanel()
      fireEvent.contextMenu(screen.getByText('prod-box'))
      fireEvent.click(screen.getByText('Delete Profile'))
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining('boom'))
      )
    })

    it('disconnects a connected but non-active profile without clearing the selection', async () => {
      connectionsRef.current = [connectedConnection]
      renderPanel({ activeProfileId: 'other-profile' })
      fireEvent.contextMenu(screen.getByText('prod-box'))
      fireEvent.click(screen.getByText('Delete Profile'))
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

      await waitFor(() => expect(mockDeleteProfile).toHaveBeenCalledWith('p1'))
      expect(mockDisconnect).toHaveBeenCalledWith('conn-1')
      expect(mockSelectProfile).not.toHaveBeenCalled()
    })
  })

  describe('hover reveal', () => {
    it('keeps row actions mounted with the opacity reveal pattern (no display toggle)', () => {
      renderPanel()
      const actions = screen.getByTitle('Edit profile').parentElement

      expect(actions).toHaveClass('flex')
      expect(actions).toHaveClass('pointer-fine:opacity-0')
      expect(actions).toHaveClass('pointer-fine:group-hover:opacity-100')
      expect(actions).toHaveClass('group-focus-within:opacity-100')
      expect(actions).not.toHaveClass('hidden')
    })
  })
})
