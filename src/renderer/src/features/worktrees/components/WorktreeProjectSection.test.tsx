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

vi.mock('@/stores/worktree-store', () => ({
  useWorktrees: vi.fn(),
  useWorktreeCount: vi.fn(),
  useProjectExpanded: vi.fn(),
  useSelectedWorktreeId: vi.fn(),
  useWorktreeActions: vi.fn(),
  useWorktreeStore: vi.fn()
}))


describe('WorktreeProjectSection', () => {
  const mockWorktrees = [
    {
      id: 'test-project-feature-auth',
      projectId: 'test-project',
      branchName: 'feature/auth',
      worktreePath: '/path/to/project/.termul/worktrees/feature-auth',
      createdAt: '2026-01-16T00:00:00.000Z',
      lastAccessedAt: '2026-01-16T00:00:00.000Z',
      isArchived: false
    },
    {
      id: 'test-project-feature-login',
      projectId: 'test-project',
      branchName: 'feature/login',
      worktreePath: '/path/to/project/.termul/worktrees/feature-login',
      createdAt: '2026-01-16T00:00:00.000Z',
      lastAccessedAt: '2026-01-16T00:00:00.000Z',
      isArchived: false
    }
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

  const mockStatusCache = new Map([
    [mockWorktrees[0].id, { dirty: false, ahead: 1, behind: 0, conflicted: false, currentBranch: 'feature/auth', updatedAt: Date.now() }],
    [mockWorktrees[1].id, { dirty: true, ahead: 0, behind: 2, conflicted: false, currentBranch: 'feature/login', updatedAt: Date.now() }]
  ])


  beforeEach(() => {
    vi.clearAllMocks()

    // Set up mock return values for the global worktree-store mock
    vi.mocked(worktreeStore.useWorktrees).mockReturnValue(mockWorktrees)
    vi.mocked(worktreeStore.useWorktreeCount).mockReturnValue(2)
    vi.mocked(worktreeStore.useProjectExpanded).mockReturnValue(false)
    vi.mocked(worktreeStore.useSelectedWorktreeId).mockReturnValue(null)
    vi.mocked(worktreeStore.useWorktreeActions).mockReturnValue(mockActions)
    vi.mocked(worktreeStore.useWorktreeStore).mockImplementation((selector: any) => selector({ statusCache: mockStatusCache }))
  })


  describe('rendering', () => {
    it('should not render worktree section header (header removed, now in ProjectItem)', () => {
      render(<WorktreeProjectSection projectId="test-project" />)
      expect(screen.queryByText('Worktrees')).not.toBeInTheDocument()
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
          id: 'test-project-archived',
          projectId: 'test-project',
          branchName: 'archived-branch',
          worktreePath: '/path/to/project/.termul/worktrees/archived',
          createdAt: '2026-01-16T00:00:00.000Z',
          lastAccessedAt: '2026-01-14T00:00:00.000Z',
          isArchived: true
        }

      ]

      vi.mocked(worktreeStore.useWorktrees).mockReturnValue(worktreesWithArchived)

      render(<WorktreeProjectSection projectId="test-project" />)
      // Should only show non-archived worktrees
      expect(screen.getByText('feature/auth')).toBeInTheDocument()
      expect(screen.getByText('feature/login')).toBeInTheDocument()
      expect(screen.queryByText('archived-branch')).not.toBeInTheDocument()
    })
  })

  describe('expand/collapse', () => {
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

      expect(mockActions.setSelectedWorktree).toHaveBeenCalledWith('test-project-feature-auth')
      expect(onWorktreeSelect).toHaveBeenCalledWith('test-project-feature-auth')

    })
  })

  describe('+ worktree button', () => {
    it('should render + worktree button when onCreateWorktree prop is provided and expanded', () => {
      vi.mocked(worktreeStore.useProjectExpanded).mockReturnValue(true)
      const onCreateWorktree = vi.fn()
      render(
        <WorktreeProjectSection
          projectId="test-project"
          onCreateWorktree={onCreateWorktree}
        />
      )

      expect(screen.getByText('worktree')).toBeInTheDocument()
    })

    it('should not render + worktree button when onCreateWorktree prop is not provided', () => {
      vi.mocked(worktreeStore.useProjectExpanded).mockReturnValue(true)
      render(<WorktreeProjectSection projectId="test-project" />)

      expect(screen.queryByText('worktree')).not.toBeInTheDocument()
    })

    it('should not render + worktree button when collapsed', () => {
      vi.mocked(worktreeStore.useProjectExpanded).mockReturnValue(false)
      const onCreateWorktree = vi.fn()
      render(
        <WorktreeProjectSection
          projectId="test-project"
          onCreateWorktree={onCreateWorktree}
        />
      )

      expect(screen.queryByText('worktree')).not.toBeInTheDocument()
    })

    it('should call onCreateWorktree when + worktree button is clicked', () => {
      vi.mocked(worktreeStore.useProjectExpanded).mockReturnValue(true)
      const onCreateWorktree = vi.fn()
      render(
        <WorktreeProjectSection
          projectId="test-project"
          onCreateWorktree={onCreateWorktree}
        />
      )

      const button = screen.getByLabelText('Create new worktree')
      button.click()

      expect(onCreateWorktree).toHaveBeenCalledWith('test-project')
    })
  })
})
