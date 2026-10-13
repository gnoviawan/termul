import type { SSHProfile } from '@shared/types/ssh.types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SSHPanel } from './SSHPanel'
import type { SSHPanelDialogsController } from './SSHPanelDialogs'

const { profilesRef } = vi.hoisted(() => ({ profilesRef: { current: [] as SSHProfile[] } }))

vi.mock('@/stores/ssh-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSSHProfiles: () => profilesRef.current,
  useSSHSessions: () => [],
  useSSHActions: () => ({
    loadProfiles: vi.fn(),
    importConfig: vi.fn(),
    duplicateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    selectProfile: vi.fn()
  })
}))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => true }))
vi.mock('./SSHHostEditor', () => ({
  SSHHostEditor: ({ open }: { open: boolean }) =>
    open ? <div data-testid="ssh-profile-form" /> : null
}))
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
  ContextMenuSeparator: () => null
}))

function makeProfile(id: string): SSHProfile {
  return {
    id,
    name: `host-${id}`,
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    portForwards: []
  }
}

function makeDialogs(): SSHPanelDialogsController {
  return {
    isOpen: false,
    openForm: vi.fn(),
    requestDelete: vi.fn(),
    form: null,
    closeForm: vi.fn(),
    saved: vi.fn(),
    deleteConfirm: null,
    cancelDelete: vi.fn(),
    confirmDelete: vi.fn()
  }
}

describe('SSHPanel popover hooks', () => {
  afterEach(() => {
    cleanup()
    profilesRef.current = []
  })

  it('raises dialog requests to an external controller and renders no dialog itself', () => {
    profilesRef.current = [makeProfile('a')]
    const dialogs = makeDialogs()
    render(<SSHPanel dialogs={dialogs} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit host-a' }))
    expect(dialogs.openForm).toHaveBeenCalledWith(profilesRef.current[0])
    fireEvent.click(screen.getByRole('button', { name: 'New host' }))
    expect(dialogs.openForm).toHaveBeenCalledWith(null)
    expect(screen.queryByTestId('ssh-profile-form')).toBeNull()
  })

  it('keeps its own dialogs when no controller is given', () => {
    profilesRef.current = [makeProfile('a')]
    render(<SSHPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit host-a' }))
    expect(screen.getByTestId('ssh-profile-form')).toBeInTheDocument()
  })

  it('renders the header lead before the SSH label', () => {
    render(<SSHPanel headerLead={<span data-testid="lead" />} />)
    const lead = screen.getByTestId('lead')
    const label = screen.getByText('SSH')
    expect(lead.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('rows are not focusable by default', () => {
    profilesRef.current = [makeProfile('a')]
    render(<SSHPanel />)
    expect(screen.getByTestId('ssh-host-row-a')).not.toHaveAttribute('tabindex')
  })

  it('focusableRows: arrows move between rows, Enter connects, Space opens the host', () => {
    profilesRef.current = [makeProfile('a'), makeProfile('b')]
    const onSelectProfile = vi.fn()
    const onConnect = vi.fn()
    render(<SSHPanel focusableRows onSelectProfile={onSelectProfile} onConnect={onConnect} />)
    const a = screen.getByTestId('ssh-host-row-a')
    const b = screen.getByTestId('ssh-host-row-b')
    a.focus()
    fireEvent.keyDown(a, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(b)
    fireEvent.keyDown(b, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(a)
    fireEvent.keyDown(b, { key: 'Enter' })
    expect(onConnect).toHaveBeenCalledWith('b')
    fireEvent.keyDown(b, { key: ' ' })
    expect(onSelectProfile).toHaveBeenCalledWith('b')
  })
})
