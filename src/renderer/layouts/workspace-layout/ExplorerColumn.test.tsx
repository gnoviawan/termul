import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SSHWorkspaceState } from '@/layouts/workspace-layout/use-ssh-workspace'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
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
    resetShellLayoutStoreForTests()
  })

  it('renders the sidePanel slot in the right panel at the stored width (340 by default)', async () => {
    render(<ExplorerColumn activeProject={project} ssh={makeSsh('closed')} sidePanel={slot} />)
    const panel = screen.getByTestId('right-panel')
    expect(panel).toContainElement(await screen.findByTestId('side-panel-slot'))
    expect(panel).toHaveStyle({ width: '340px' })
    // Paper "Side panel": 0.5px start hairline on the background surface.
    expect(panel).toHaveClass('border-l-[0.5px]', 'border-border', 'bg-background')
  })

  it('resizes from its left edge: dragging left widens the panel', async () => {
    resetShellLayoutStoreForTests()
    useShellLayoutStore.setState({ status: 'ready' })
    render(<ExplorerColumn activeProject={project} ssh={makeSsh('closed')} sidePanel={slot} />)
    const handle = screen.getByRole('separator', { name: 'Resize side panel' })
    expect(handle).toHaveClass('left-0')
    fireEvent.mouseDown(handle, { clientX: 500 })
    fireEvent.mouseMove(document, { clientX: 460 })
    fireEvent.mouseUp(document)
    expect(useShellLayoutStore.getState().sidePanelWidth).toBe(380)
    expect(screen.getByTestId('right-panel')).toHaveStyle({ width: '380px' })
  })

  it('shows only the remote files, in the same right panel, for a connected session', async () => {
    render(<ExplorerColumn activeProject={project} ssh={makeSsh('session')} sidePanel={slot} />)
    const ssh = await screen.findByTestId('ssh-explorer')
    expect(screen.queryByTestId('side-panel-slot')).toBeNull()
    expect(screen.getByTestId('right-panel')).toContainElement(ssh)
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
