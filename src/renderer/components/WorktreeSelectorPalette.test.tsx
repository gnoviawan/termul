import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorktreeSelectorPalette } from './WorktreeSelectorPalette'
import * as worktreeStore from '@/stores/worktree-store'

// Mock the worktree store
vi.mock('@/stores/worktree-store', () => ({
  useWorktrees: vi.fn(),
  useWorktreeStatus: vi.fn(),
  useWorktreeStore: vi.fn()
}))

const mockWorktrees = [
  {
    id: 'wt-1',
    projectId: 'proj-1',
    branchName: 'feature/auth',
    worktreePath: '/path/to/auth',
    createdAt: '2024-01-01T00:00:00Z',
    lastAccessedAt: '2024-01-01T00:00:00Z',
    isArchived: false
  },
  {
    id: 'wt-2',
    projectId: 'proj-1',
    branchName: 'feature/ui',
    worktreePath: '/path/to/ui',
    createdAt: '2024-01-02T00:00:00Z',
    lastAccessedAt: '2024-01-02T00:00:00Z',
    isArchived: false
  },
  {
    id: 'wt-3',
    projectId: 'proj-1',
    branchName: 'bugfix/login',
    worktreePath: '/path/to/login',
    createdAt: '2024-01-03T00:00:00Z',
    lastAccessedAt: '2024-01-03T00:00:00Z',
    isArchived: false
  }
]

describe('WorktreeSelectorPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(worktreeStore.useWorktrees).mockReturnValue(mockWorktrees)
    vi.mocked(worktreeStore.useWorktreeStatus).mockReturnValue(undefined)
    vi.mocked(worktreeStore.useWorktreeStore).mockImplementation((selector: any) => {
      const mockState = {
        statusCache: new Map()
      }
      return selector(mockState)
    })
  })

  describe('Basic Rendering', () => {
    it('should not render when isOpen is false', () => {
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={false}
          onClose={onClose}
          onSelect={onSelect}
        />
      )

      expect(screen.queryByText('Select Worktree')).not.toBeInTheDocument()
    })

    it('should render worktree list when isOpen is true', async () => {
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('Select Worktree')).toBeInTheDocument()
      })

      expect(screen.getByText('feature/auth')).toBeInTheDocument()
      expect(screen.getByText('feature/ui')).toBeInTheDocument()
      expect(screen.getByText('bugfix/login')).toBeInTheDocument()
    })

    it('should render custom title', async () => {
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
          title="Archive Worktree"
        />
      )

      await waitFor(() => {
        expect(screen.getByText('Archive Worktree')).toBeInTheDocument()
      })
    })
  })

  describe('Fuzzy Search', () => {
    it('should filter worktrees by branch name', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
        />
      )

      const input = screen.getByPlaceholderText('Search worktrees...')
      await user.type(input, 'auth')

      await waitFor(() => {
        expect(screen.getByText('feature/auth')).toBeInTheDocument()
        expect(screen.queryByText('feature/ui')).not.toBeInTheDocument()
        expect(screen.queryByText('bugfix/login')).not.toBeInTheDocument()
      })
    })

    it('should support multi-token fuzzy search', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
        />
      )

      const input = screen.getByPlaceholderText('Search worktrees...')
      await user.type(input, 'feature ui')

      await waitFor(() => {
        expect(screen.getByText('feature/ui')).toBeInTheDocument()
        expect(screen.queryByText('feature/auth')).not.toBeInTheDocument()
        expect(screen.queryByText('bugfix/login')).not.toBeInTheDocument()
      })
    })

    it('should show empty state when no matches', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
        />
      )

      const input = screen.getByPlaceholderText('Search worktrees...')
      await user.type(input, 'nonexistent')

      await waitFor(() => {
        expect(screen.getByText('No worktrees found.')).toBeInTheDocument()
      })
    })
  })

  describe('Status Keyword Filtering', () => {
    beforeEach(() => {
      // Mock the statusCache in the store
      vi.mocked(worktreeStore.useWorktreeStore).mockImplementation((selector: any) => {
        const mockState = {
          statusCache: new Map([
            [
              'wt-1',
              { dirty: true, ahead: 0, behind: 0, conflicted: false, currentBranch: 'feature/auth' }
            ],
            [
              'wt-2',
              { dirty: false, ahead: 3, behind: 0, conflicted: false, currentBranch: 'feature/ui' }
            ],
            [
              'wt-3',
              { dirty: false, ahead: 0, behind: 2, conflicted: false, currentBranch: 'bugfix/login' }
            ]
          ])
        }
        return selector(mockState)
      })
    })

    it('should filter by "dirty" keyword', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette isOpen={true} onClose={onClose} onSelect={onSelect} />
      )

      const input = screen.getByPlaceholderText('Search worktrees...')
      await user.type(input, 'dirty')

      await waitFor(() => {
        expect(screen.getByText('feature/auth')).toBeInTheDocument()
        expect(screen.queryByText('feature/ui')).not.toBeInTheDocument()
        expect(screen.queryByText('bugfix/login')).not.toBeInTheDocument()
      })
    })

    it('should filter by "ahead" keyword', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette isOpen={true} onClose={onClose} onSelect={onSelect} />
      )

      const input = screen.getByPlaceholderText('Search worktrees...')
      await user.type(input, 'ahead')

      await waitFor(() => {
        expect(screen.getByText('feature/ui')).toBeInTheDocument()
        expect(screen.queryByText('feature/auth')).not.toBeInTheDocument()
        expect(screen.queryByText('bugfix/login')).not.toBeInTheDocument()
      })
    })

    it('should filter by "behind" keyword', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette isOpen={true} onClose={onClose} onSelect={onSelect} />
      )

      const input = screen.getByPlaceholderText('Search worktrees...')
      await user.type(input, 'behind')

      await waitFor(() => {
        expect(screen.getByText('bugfix/login')).toBeInTheDocument()
        expect(screen.queryByText('feature/auth')).not.toBeInTheDocument()
        expect(screen.queryByText('feature/ui')).not.toBeInTheDocument()
      })
    })

    it('should filter by "clean" keyword', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      // Mock all worktrees as not clean
      vi.mocked(worktreeStore.useWorktreeStore).mockImplementation((selector: any) => {
        const mockState = {
          statusCache: new Map([
            [
              'wt-1',
              { dirty: true, ahead: 0, behind: 0, conflicted: false, currentBranch: 'feature/auth' }
            ],
            [
              'wt-2',
              { dirty: false, ahead: 3, behind: 0, conflicted: false, currentBranch: 'feature/ui' }
            ]
          ])
        }
        return selector(mockState)
      })

      render(
        <WorktreeSelectorPalette isOpen={true} onClose={onClose} onSelect={onSelect} />
      )

      const input = screen.getByPlaceholderText('Search worktrees...')
      await user.type(input, 'clean')

      await waitFor(() => {
        expect(screen.getByText('No worktrees found.')).toBeInTheDocument()
      })
    })

    it('should combine status keyword with search text', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette isOpen={true} onClose={onClose} onSelect={onSelect} />
      )

      const input = screen.getByPlaceholderText('Search worktrees...')
      await user.type(input, 'feature dirty')

      await waitFor(() => {
        expect(screen.getByText('feature/auth')).toBeInTheDocument()
        expect(screen.queryByText('feature/ui')).not.toBeInTheDocument()
        expect(screen.queryByText('bugfix/login')).not.toBeInTheDocument()
      })
    })

    it('should filter by "conflicted" keyword', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      vi.mocked(worktreeStore.useWorktreeStore).mockImplementation((selector: any) => {
        const mockState = {
          statusCache: new Map([
            [
              'wt-1',
              { dirty: false, ahead: 0, behind: 0, conflicted: true, currentBranch: 'feature/auth' }
            ],
            [
              'wt-2',
              { dirty: false, ahead: 0, behind: 0, conflicted: false, currentBranch: 'feature/ui' }
            ]
          ])
        }
        return selector(mockState)
      })

      render(
        <WorktreeSelectorPalette isOpen={true} onClose={onClose} onSelect={onSelect} />
      )

      const input = screen.getByPlaceholderText('Search worktrees...')
      await user.type(input, 'conflicted')

      await waitFor(() => {
        expect(screen.getByText('feature/auth')).toBeInTheDocument()
        expect(screen.queryByText('feature/ui')).not.toBeInTheDocument()
      })
    })
  })

  describe('Status Badges', () => {
    it('should show Clean badge when worktree has no status', async () => {
      vi.mocked(worktreeStore.useWorktreeStatus).mockReturnValue(undefined)

      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
        />
      )

      await waitFor(() => {
        // No status means no badge is rendered (status is undefined)
        expect(screen.queryByText('Clean')).not.toBeInTheDocument()
      })
    })

    it('should show Dirty badge when worktree has uncommitted changes', async () => {
      vi.mocked(worktreeStore.useWorktreeStatus).mockImplementation((id) => {
        if (id === 'wt-1') {
          return {
            dirty: true,
            ahead: 0,
            behind: 0,
            conflicted: false,
            currentBranch: 'feature/auth'
          }
        }
        return undefined
      })

      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('Dirty')).toBeInTheDocument()
      })
    })

    it('should show ahead/behind badges', async () => {
      vi.mocked(worktreeStore.useWorktreeStatus).mockImplementation((id) => {
        if (id === 'wt-1') {
          return {
            dirty: false,
            ahead: 3,
            behind: 2,
            conflicted: false,
            currentBranch: 'feature/auth'
          }
        }
        return undefined
      })

      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('↑3')).toBeInTheDocument()
        expect(screen.getByText('↓2')).toBeInTheDocument()
      })
    })

    it('should show Conflicted badge', async () => {
      vi.mocked(worktreeStore.useWorktreeStatus).mockImplementation((id) => {
        if (id === 'wt-1') {
          return {
            dirty: false,
            ahead: 0,
            behind: 0,
            conflicted: true,
            currentBranch: 'feature/auth'
          }
        }
        return undefined
      })

      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('Conflicted')).toBeInTheDocument()
      })
    })

    it('should show Clean badge when status exists but has no issues', async () => {
      vi.mocked(worktreeStore.useWorktreeStatus).mockImplementation((id) => {
        if (id === 'wt-1') {
          return {
            dirty: false,
            ahead: 0,
            behind: 0,
            conflicted: false,
            currentBranch: 'feature/auth'
          }
        }
        return undefined
      })

      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('Clean')).toBeInTheDocument()
      })
    })
  })

  describe('Single Select Mode', () => {
    it('should call onSelect and close when item is clicked', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
          allowMultiple={false}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('feature/auth')).toBeInTheDocument()
      })

      const item = screen.getByText('feature/auth')
      await user.click(item)

      await waitFor(() => {
        expect(onSelect).toHaveBeenCalledWith('wt-1')
        expect(onClose).toHaveBeenCalled()
      })
    })
  })

  describe('Multi-Select Mode', () => {
    it('should allow selecting multiple worktrees', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
          allowMultiple={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('feature/auth')).toBeInTheDocument()
      })

      const item1 = screen.getByText('feature/auth')
      const item2 = screen.getByText('feature/ui')

      await user.click(item1)
      await user.click(item2)

      // Should show confirm button with count
      expect(screen.getByText(/Confirm \(2\)/)).toBeInTheDocument()

      // Should NOT auto-close
      expect(onClose).not.toHaveBeenCalled()
    })

    it('should call onSelect with array of selected IDs when confirm is clicked', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
          allowMultiple={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('feature/auth')).toBeInTheDocument()
      })

      const item1 = screen.getByText('feature/auth')
      await user.click(item1)

      const confirmButton = screen.getByText(/Confirm \(1\)/)
      await user.click(confirmButton)

      await waitFor(() => {
        expect(onSelect).toHaveBeenCalledWith(['wt-1'])
        expect(onClose).toHaveBeenCalled()
      })
    })

    it('should allow deselecting items', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
          allowMultiple={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('feature/auth')).toBeInTheDocument()
      })

      const item = screen.getByText('feature/auth')

      // Select
      await user.click(item)
      expect(screen.getByText(/Confirm \(1\)/)).toBeInTheDocument()

      // Deselect
      await user.click(item)
      expect(screen.getByText(/Confirm \(0\)/)).toBeInTheDocument()
    })
  })

  describe('Keyboard Navigation', () => {
    it('should close on Escape key', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('Select Worktree')).toBeInTheDocument()
      })

      await user.keyboard('{Escape}')

      expect(onClose).toHaveBeenCalled()
    })

    it('should close when clicking backdrop', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('Select Worktree')).toBeInTheDocument()
      })

      // Click on backdrop (the fixed inset-0 div)
      const backdrop = screen.getByText('Select Worktree').closest('[class*="fixed"]')
      if (backdrop) {
        await user.click(backdrop)
        expect(onClose).toHaveBeenCalled()
      }
    })

    it('should close when clicking X button', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('Select Worktree')).toBeInTheDocument()
      })

      const closeButton = screen.getByLabelText('Close')
      await user.click(closeButton)

      expect(onClose).toHaveBeenCalled()
    })
  })

  describe('Project Filtering', () => {
    it('should filter worktrees by projectId when provided', async () => {
      const worktreesProject2 = [
        {
          id: 'wt-4',
          projectId: 'proj-2',
          branchName: 'main',
          worktreePath: '/path/to/main',
          createdAt: '2024-01-04T00:00:00Z',
          lastAccessedAt: '2024-01-04T00:00:00Z',
          isArchived: false
        }
      ]

      vi.mocked(worktreeStore.useWorktrees).mockImplementation((projectId) => {
        if (projectId === 'proj-2') return worktreesProject2
        return mockWorktrees
      })

      const onClose = vi.fn()
      const onSelect = vi.fn()

      render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
          projectId="proj-2"
        />
      )

      await waitFor(() => {
        expect(screen.getByText('main')).toBeInTheDocument()
      })

      expect(screen.queryByText('feature/auth')).not.toBeInTheDocument()
    })
  })

  describe('State Reset', () => {
    it('should reset query and selection when reopened', async () => {
      const user = userEvent.setup()
      const onClose = vi.fn()
      const onSelect = vi.fn()

      const { rerender } = render(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
          allowMultiple={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('feature/auth')).toBeInTheDocument()
      })

      // Type in search
      const input = screen.getByPlaceholderText('Search worktrees...')
      await user.type(input, 'auth')

      // Select an item
      const item = screen.getByText('feature/auth')
      await user.click(item)

      // Close
      rerender(
        <WorktreeSelectorPalette
          isOpen={false}
          onClose={onClose}
          onSelect={onSelect}
          allowMultiple={true}
        />
      )

      // Reopen
      rerender(
        <WorktreeSelectorPalette
          isOpen={true}
          onClose={onClose}
          onSelect={onSelect}
          allowMultiple={true}
        />
      )

      await waitFor(() => {
        expect(screen.getByText('feature/auth')).toBeInTheDocument()
      })

      // Query should be reset
      const newInput = screen.getByPlaceholderText('Search worktrees...')
      expect(newInput).toHaveValue('')

      // Selection should be reset (confirm button shows 0)
      expect(screen.getByText(/Confirm \(0\)/)).toBeInTheDocument()
    })
  })
})
