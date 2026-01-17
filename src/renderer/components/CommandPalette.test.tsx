import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CommandPalette } from './CommandPalette'
import type { Project } from '@/types/project'
import { useRecentCommandsStore } from '@/stores/recent-commands-store'

const mockProjects: Project[] = [
  { id: 'project-1', name: 'Project One', color: 'blue', gitBranch: 'main', path: '/repo/one' }
]

describe('CommandPalette', () => {
  const mockOnClose = vi.fn()
  const mockOnSwitchProject = vi.fn()
  const mockOnNewTerminal = vi.fn()
  const mockOnSaveSnapshot = vi.fn()
  const mockOnOpenWorktreeCreate = vi.fn()

  beforeEach(() => {
    useRecentCommandsStore.setState({ recentCommandIds: [] })
    vi.clearAllMocks()
  })

  it('renders worktree action definitions', () => {
    render(
      <CommandPalette
        isOpen={true}
        onClose={mockOnClose}
        projects={mockProjects}
        onSwitchProject={mockOnSwitchProject}
        onNewTerminal={mockOnNewTerminal}
      />
    )

    expect(screen.getByText('Create worktree')).toBeInTheDocument()
    expect(screen.getByText('Archive worktree')).toBeInTheDocument()
    expect(screen.getByText('Merge worktree')).toBeInTheDocument()
    expect(screen.getByText('Open worktree terminal')).toBeInTheDocument()
    expect(screen.getByText('Delete worktree')).toBeInTheDocument()
    expect(screen.getByText('Restore archived worktree')).toBeInTheDocument()
    expect(screen.getByText('Search worktrees')).toBeInTheDocument()
    expect(screen.getByText('Toggle worktree grouping')).toBeInTheDocument()
    expect(screen.getByText('Show worktree status')).toBeInTheDocument()
  })

  it('highlights matching segments for fuzzy queries', async () => {
    render(
      <CommandPalette
        isOpen={true}
        onClose={mockOnClose}
        projects={mockProjects}
        onSwitchProject={mockOnSwitchProject}
        onNewTerminal={mockOnNewTerminal}
      />
    )

    const input = screen.getByPlaceholderText('Type a command or search...') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'cre wor' } })

    await waitFor(() => {
      const highlights = document.querySelectorAll('.text-primary')
      expect(highlights.length).toBeGreaterThan(0)
    })
  })

  it('closes palette when Escape key is pressed', async () => {
    render(
      <CommandPalette
        isOpen={true}
        onClose={mockOnClose}
        projects={mockProjects}
        onSwitchProject={mockOnSwitchProject}
        onNewTerminal={mockOnNewTerminal}
      />
    )

    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' })

    await waitFor(() => {
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })
  })

  it('executes worktree create action', async () => {
    render(
      <CommandPalette
        isOpen={true}
        onClose={mockOnClose}
        projects={mockProjects}
        onSwitchProject={mockOnSwitchProject}
        onNewTerminal={mockOnNewTerminal}
        onOpenWorktreeCreate={mockOnOpenWorktreeCreate}
      />
    )

    const createWorktreeItem = screen.getByText('Create worktree')
    fireEvent.click(createWorktreeItem)

    await waitFor(() => {
      expect(mockOnOpenWorktreeCreate).toHaveBeenCalledTimes(1)
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })
  })

  it('executes new terminal action', async () => {
    render(
      <CommandPalette
        isOpen={true}
        onClose={mockOnClose}
        projects={mockProjects}
        onSwitchProject={mockOnSwitchProject}
        onNewTerminal={mockOnNewTerminal}
      />
    )

    const newTerminalItem = screen.getByText('New Terminal')
    fireEvent.click(newTerminalItem)

    await waitFor(() => {
      expect(mockOnNewTerminal).toHaveBeenCalledTimes(1)
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    })
  })

  it('shows recent commands when available', () => {
    useRecentCommandsStore.setState({ recentCommandIds: ['new-terminal', 'worktree-create'] })

    render(
      <CommandPalette
        isOpen={true}
        onClose={mockOnClose}
        projects={mockProjects}
        onSwitchProject={mockOnSwitchProject}
        onNewTerminal={mockOnNewTerminal}
      />
    )

    expect(screen.getByText('Recent')).toBeInTheDocument()
  })

  it('filters commands based on query', async () => {
    render(
      <CommandPalette
        isOpen={true}
        onClose={mockOnClose}
        projects={mockProjects}
        onSwitchProject={mockOnSwitchProject}
        onNewTerminal={mockOnNewTerminal}
      />
    )

    const input = screen.getByPlaceholderText('Type a command or search...') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'worktree' } })

    await waitFor(() => {
      expect(screen.getByText('Create worktree')).toBeInTheDocument()
      expect(screen.getByText('Archive worktree')).toBeInTheDocument()
    })
  })

  it('renders keyboard navigation hints', () => {
    render(
      <CommandPalette
        isOpen={true}
        onClose={mockOnClose}
        projects={mockProjects}
        onSwitchProject={mockOnSwitchProject}
        onNewTerminal={mockOnNewTerminal}
      />
    )

    expect(screen.getByText('to navigate')).toBeInTheDocument()
    expect(screen.getByText('to select')).toBeInTheDocument()
    expect(screen.getByText('to close')).toBeInTheDocument()
  })
})
