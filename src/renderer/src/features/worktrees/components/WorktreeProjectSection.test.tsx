/**
 * Unit tests for WorktreeProjectSection Component
 *
 * Tests worktree section rendering, expand/collapse, and integration with ProjectSidebar.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WorktreeProjectSection } from './WorktreeProjectSection'

// Import the mocked store functions at module level
import * as worktreeStore from '@/stores/worktree-store'

describe('WorktreeProjectSection', () => {
  const mockWorktrees = [
    {
      id: 'test-project-feature-auth-1234567890',
      projectId: 'test-project',
      branchName: 'feature/auth',
      worktreePath: '/path/to/project/.termul/worktrees/feature-auth',
      createdAt: '2026-01-16T00:00:00.000Z',
      lastAccessedAt: '2026-01-16T00:00:00.000Z',
      isArchived: false,
    },
    {
      id: 'test-project-feature-login-1234567891',
      projectId: 'test-project',
      branchName: 'feature/login',
      worktreePath: '/path/to/project/.termul/worktrees/feature-login',
      createdAt: '2026-01-16T00:00:00.000Z',
      lastAccessedAt: '2026-01-15T00:00:00.000Z',
      isArchived: false,
    },
  ]

  const mockActions = {
    toggleProjectExpanded: vi.fn(),
    setSelectedWorktree: vi.fn(),
    createWorktree: vi.fn(),
    deleteWorktree: vi.fn(),
    archiveWorktree: vi.fn(),
    updateWorktreeStatus: vi.fn(),
    setActiveWorktree: vi.fn(),
    setProjectExpanded: vi.fn(),
    refreshStatus: vi.fn(),
    loadWorktrees: vi.fn(),
    clearError: vi.fn(),
    initializeEventListeners: vi.fn()
  }

  beforeEach(() => {
    vi.clearAllMocks()

    // Set up mock return values for the global worktree-store mock
    vi.mocked(worktreeStore.useWorktrees).mockReturnValue(mockWorktrees)
    vi.mocked(worktreeStore.useWorktreeCount).mockReturnValue(2)
    vi.mocked(worktreeStore.useProjectExpanded).mockReturnValue(false)
    vi.mocked(worktreeStore.useSelectedWorktreeId).mockReturnValue(null)
    vi.mocked(worktreeStore.useWorktreeActions).mockReturnValue(mockActions)
  })

  describe('rendering', () => {
    it('should render worktree section header when worktrees exist', () => {
      render(<WorktreeProjectSection projectId="test-project" />)
      expect(screen.getByText('Worktrees')).toBeInTheDocument()
    })

    it('should display worktree count badge', () => {
      vi.mocked(worktreeStore.useWorktreeCount).mockReturnValue(3)
      render(<WorktreeProjectSection projectId="test-project" />)
      expect(screen.getByText('3')).toBeInTheDocument()
    })

    it('should not render when no worktrees exist', () => {
      vi.mocked(worktreeStore.useWorktrees).mockReturnValue([])
      const { container } = render(<WorktreeProjectSection projectId="test-project" />)
      expect(container.firstChild).toBeNull()
    })

    it('should filter out archived worktrees', () => {
      const worktreesWithArchived = [
        ...mockWorktrees,
        {
          id: 'test-project-archived-1234567892',
          projectId: 'test-project',
          branchName: 'archived-branch',
          worktreePath: '/path/to/project/.termul/worktrees/archived',
          createdAt: '2026-01-16T00:00:00.000Z',
          lastAccessedAt: '2026-01-14T00:00:00.000Z',
          isArchived: true,
        },
      ]

      vi.mocked(worktreeStore.useWorktrees).mockReturnValue(worktreesWithArchived)
      vi.mocked(worktreeStore.useWorktreeCount).mockReturnValue(2)

      render(<WorktreeProjectSection projectId="test-project" />)
      expect(screen.getByText('2')).toBeInTheDocument()
    })
  })

  describe('expand/collapse', () => {
    it('should show chevron-right when collapsed', () => {
      vi.mocked(worktreeStore.useProjectExpanded).mockReturnValue(false)
      render(<WorktreeProjectSection projectId="test-project" />)
      const button = screen.getByRole('button', { name: /worktrees for project/i })
      expect(button).toHaveAttribute('aria-expanded', 'false')
    })

    it('should show chevron-down when expanded', () => {
      vi.mocked(worktreeStore.useProjectExpanded).mockReturnValue(true)
      render(<WorktreeProjectSection projectId="test-project" />)
      const button = screen.getByRole('button', { name: /worktrees for project/i })
      expect(button).toHaveAttribute('aria-expanded', 'true')
    })

    it('should call toggleProjectExpanded when header clicked', () => {
      render(<WorktreeProjectSection projectId="test-project" />)
      const button = screen.getByRole('button', { name: /worktrees for project/i })
      button.click()
      expect(mockActions.toggleProjectExpanded).toHaveBeenCalledWith('test-project')
    })

    it('should show worktree list when expanded', () => {
      vi.mocked(worktreeStore.useProjectExpanded).mockReturnValue(true)
      render(<WorktreeProjectSection projectId="test-project" />)
      expect(screen.getByText('feature/auth')).toBeInTheDocument()
      expect(screen.getByText('feature/login')).toBeInTheDocument()
    })

    it('should hide worktree list when collapsed', () => {
      vi.mocked(worktreeStore.useProjectExpanded).mockReturnValue(false)
      render(<WorktreeProjectSection projectId="test-project" />)
      expect(screen.queryByText('feature/auth')).not.toBeInTheDocument()
      expect(screen.queryByText('feature/login')).not.toBeInTheDocument()
    })
  })

  describe('interactions', () => {
    it('should call onWorktreeSelect when worktree is selected', () => {
      vi.mocked(worktreeStore.useProjectExpanded).mockReturnValue(true)
      const onWorktreeSelect = vi.fn()
      render(
        <WorktreeProjectSection
          projectId="test-project"
          onWorktreeSelect={onWorktreeSelect}
        />
      )

      const worktreeButton = screen.getByText('feature/auth')
      worktreeButton.click()

      expect(mockActions.setSelectedWorktree).toHaveBeenCalledWith('test-project-feature-auth-1234567890')
      expect(onWorktreeSelect).toHaveBeenCalledWith('test-project-feature-auth-1234567890')
    })
  })

  describe('accessibility', () => {
    it('should have proper aria-expanded attribute', () => {
      vi.mocked(worktreeStore.useProjectExpanded).mockReturnValue(false)
      render(<WorktreeProjectSection projectId="test-project" />)
      const button = screen.getByRole('button', { name: /worktrees for project/i })
      expect(button).toHaveAttribute('aria-expanded', 'false')
    })

    it('should have proper aria-label for worktree count', () => {
      vi.mocked(worktreeStore.useWorktreeCount).mockReturnValue(1)
      render(<WorktreeProjectSection projectId="test-project" />)
      expect(screen.getByLabelText('1 worktree')).toBeInTheDocument()
    })

    it('should have plural aria-label for multiple worktrees', () => {
      vi.mocked(worktreeStore.useWorktreeCount).mockReturnValue(2)
      render(<WorktreeProjectSection projectId="test-project" />)
      expect(screen.getByLabelText('2 worktrees')).toBeInTheDocument()
    })
  })
})
