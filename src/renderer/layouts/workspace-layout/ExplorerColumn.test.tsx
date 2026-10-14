import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SSHWorkspaceState } from '@/layouts/workspace-layout/use-ssh-workspace'
import type { Project } from '@/types/project'
import { ExplorerColumn } from './ExplorerColumn'

const visible = vi.hoisted(() => ({ value: true }))

vi.mock('@/stores/file-explorer-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useFileExplorerVisible: () => visible.value
}))
vi.mock('@/components/ssh/SSHFileExplorer', () => ({
  SSHFileExplorer: () => <div data-testid="ssh-explorer" />
}))

const project = { id: 'p1', name: 'One', path: '/repo', color: 'blue' } as Project

/** SSH state: workspace closed, open on the Hosts tab, or open on a connected session. */
function makeSsh(mode: 'closed' | 'hosts' | 'session'): SSHWorkspaceState {
  return {
    workspaceOpen: mode !== 'closed',
    activeSSHProfile: mode === 'session' ? { id: 's1', name: 'Box' } : null,
    activeSSHSession:
      mode === 'session' ? { id: 'tab', attemptId: 'attempt-1', status: 'connected' } : null
  } as unknown as SSHWorkspaceState
}

const slot = <div data-testid="side-panel-slot" />

describe('ExplorerColumn', () => {
  beforeEach(() => {
    visible.value = true
  })

  it('renders the sidePanel slot in place of the File Explorer', async () => {
    render(<ExplorerColumn activeProject={project} ssh={makeSsh('closed')} sidePanel={slot} />)
    expect(await screen.findByTestId('side-panel-slot')).toBeInTheDocument()
  })

  it('shows only the remote files, at their own width, for a connected session', async () => {
    render(<ExplorerColumn activeProject={project} ssh={makeSsh('session')} sidePanel={slot} />)
    const ssh = await screen.findByTestId('ssh-explorer')
    expect(screen.queryByTestId('side-panel-slot')).toBeNull()
    expect(ssh.parentElement).toHaveClass('w-80')
  })

  it('shows neither column on the Hosts tab', () => {
    render(<ExplorerColumn activeProject={project} ssh={makeSsh('hosts')} sidePanel={slot} />)
    expect(screen.queryByTestId('ssh-explorer')).toBeNull()
    expect(screen.queryByTestId('side-panel-slot')).toBeNull()
  })

  it('renders nothing for the slot while the explorer is hidden', () => {
    visible.value = false
    render(<ExplorerColumn activeProject={project} ssh={makeSsh('closed')} sidePanel={slot} />)
    expect(screen.queryByTestId('side-panel-slot')).toBeNull()
  })
})
