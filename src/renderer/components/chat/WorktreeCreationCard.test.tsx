import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorktreeProgressStore } from '@/stores/worktree-progress-store'
import { WorktreeCreationCard } from './WorktreeCreationCard'

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: () => true
  }
})

function resetStore(): void {
  useWorktreeProgressStore.setState({ ops: {} })
}

describe('WorktreeCreationCard', () => {
  beforeEach(() => {
    resetStore()
  })

  it('shows "Creating worktree.." while running, expanded with steps and the streaming log', () => {
    const store = useWorktreeProgressStore.getState()
    store.begin('p1', 'feat/worktree-row')
    store.appendLine('p1', 'Preparing worktree (new branch)')
    store.appendLine('p1', 'Updating files:  40% (4/10)')

    render(<WorktreeCreationCard progressId="p1" />)

    expect(screen.getByText('Creating worktree..')).toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: /Creating worktree/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    // Trailing detail: branch + live percent.
    expect(trigger).toHaveTextContent('feat/worktree-row')
    expect(trigger).toHaveTextContent('40%')
    // Detail: step rows + streamed git log.
    expect(screen.getByText('Preparing workspace')).toBeInTheDocument()
    expect(screen.getByText('Checking out files')).toBeInTheDocument()
    expect(screen.getByText('Preparing worktree (new branch)')).toBeInTheDocument()
    expect(screen.getByText(/Updating files:/)).toBeInTheDocument()
  })

  it('flips the title to "Worktree created.." on done and stays expanded', () => {
    const store = useWorktreeProgressStore.getState()
    store.begin('p1', 'feat/x')
    store.appendLine('p1', 'Preparing worktree')
    render(<WorktreeCreationCard progressId="p1" />)
    expect(screen.getByText('Creating worktree..')).toBeInTheDocument()

    act(() => {
      useWorktreeProgressStore.getState().finish('p1')
    })

    expect(screen.queryByText('Creating worktree..')).toBeNull()
    expect(screen.getByText('Worktree created..')).toBeInTheDocument()
    // No auto-collapse on completion: the detail stays open by default.
    expect(screen.getByRole('button', { name: /Worktree created/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByText('Preparing workspace')).toBeInTheDocument()
    expect(screen.getByText('Preparing worktree')).toBeInTheDocument()
  })

  it('renders "Creating worktree.." expanded when the op record is missing', () => {
    render(<WorktreeCreationCard progressId="ghost" />)
    expect(screen.getByText('Creating worktree..')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Creating worktree/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByText('Preparing workspace')).toBeInTheDocument()
  })

  it('keeps destructive styling and shows the error inside the detail on failure', () => {
    const store = useWorktreeProgressStore.getState()
    store.begin('p2', 'feat/y')
    store.appendLine('p2', 'Preparing worktree')
    store.finish('p2', 'disk full')
    render(<WorktreeCreationCard progressId="p2" />)

    expect(screen.getByText('Creating worktree..')).toHaveClass('text-destructive')
    expect(screen.getByRole('alert')).toHaveTextContent('disk full')
    // Still expanded by default in the error state.
    expect(screen.getByRole('button', { name: /Creating worktree/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('collapses and re-expands on user click only', async () => {
    const store = useWorktreeProgressStore.getState()
    store.begin('p3')
    store.appendLine('p3', 'Preparing worktree')
    render(<WorktreeCreationCard progressId="p3" />)

    const trigger = screen.getByRole('button', { name: /Creating worktree/ })
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => {
      expect(screen.queryByText('Preparing workspace')).not.toBeInTheDocument()
    })

    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Preparing workspace')).toBeInTheDocument()
  })

  it('keeps a user collapse across unmount/remount (virtualizer eviction)', async () => {
    const store = useWorktreeProgressStore.getState()
    store.begin('p4')
    store.appendLine('p4', 'Preparing worktree')
    const first = render(<WorktreeCreationCard progressId="p4" />)
    fireEvent.click(screen.getByRole('button', { name: /Creating worktree/ }))
    await waitFor(() => {
      expect(screen.queryByText('Preparing workspace')).not.toBeInTheDocument()
    })
    first.unmount()

    // A fresh mount for the same progressId (e.g. the row scrolled back into
    // the virtualized window) restores the collapsed state.
    render(<WorktreeCreationCard progressId="p4" />)
    const trigger = screen.getByRole('button', { name: /Creating worktree/ })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Preparing workspace')).not.toBeInTheDocument()
  })

  it('links the toggle button to the detail region via aria-controls', () => {
    const store = useWorktreeProgressStore.getState()
    store.begin('p5')
    store.appendLine('p5', 'Preparing worktree')
    render(<WorktreeCreationCard progressId="p5" />)

    const trigger = screen.getByRole('button', { name: /Creating worktree/ })
    const controlsId = trigger.getAttribute('aria-controls')
    expect(controlsId).toBeTruthy()
    const detail = controlsId ? document.getElementById(controlsId) : null
    expect(detail).toBeInTheDocument()
    expect(detail).toHaveTextContent('Preparing workspace')
  })
})
