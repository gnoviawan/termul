/**
 * Unit tests for WorktreeItem Component
 *
 * Tests worktree item rendering, status badges, and keyboard interactions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorktreeItem } from './WorktreeItem'
import type { WorktreeMetadata, WorktreeStatus } from '../../worktree.types'

// Mock worktree hooks
vi.mock('@/stores/worktree-store', () => ({
  useWorktreeStatus: vi.fn(),
  useWorktreeActions: vi.fn(),
}))

// Mock FreshnessIndicator component
vi.mock('./FreshnessIndicator', () => ({
  FreshnessIndicator: () => <span data-testid="freshness">2d ago</span>,
}))

// Mock cn utility
vi.mock('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}))

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Circle: () => <span data-testid="dot-icon">●</span>,
  ArrowUp: () => <span data-testid="arrow-up">↑</span>,
  ArrowDown: () => <span data-testid="arrow-down">↓</span>,
  AlertTriangle: () => <span data-testid="warning">⚠</span>,
  MoreVertical: () => <span data-testid="more">⋮</span>,
  Clock: () => <span data-testid="clock">🕐</span>,
}))

describe('WorktreeItem', () => {
  const mockWorktree: WorktreeMetadata = {
    id: 'test-project-feature-auth-1234567890',
    projectId: 'test-project',
    branchName: 'feature/auth',
    worktreePath: '/path/to/project/.termul/worktrees/feature-auth',
    createdAt: '2026-01-16T00:00:00.000Z',
    lastAccessedAt: '2026-01-16T00:00:00.000Z',
    isArchived: false,
  }

  const cleanStatus: WorktreeStatus = {
    dirty: false,
    ahead: 0,
    behind: 0,
    conflicted: false,
    currentBranch: 'feature/auth',
    updatedAt: Date.now(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('rendering', () => {
    it('should render worktree branch name', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      useWorktreeStatus.mockReturnValue(cleanStatus)

      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      expect(screen.getByText('feature/auth')).toBeInTheDocument()
    })

    it('should render no badges when status is clean', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      useWorktreeStatus.mockReturnValue(cleanStatus)

      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      expect(screen.queryByTestId('dot-icon')).not.toBeInTheDocument()
      expect(screen.queryByTestId('arrow-up')).not.toBeInTheDocument()
      expect(screen.queryByTestId('arrow-down')).not.toBeInTheDocument()
      expect(screen.queryByTestId('warning')).not.toBeInTheDocument()
    })

    it('should render dirty badge with dot icon', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      const dirtyStatus: WorktreeStatus = { ...cleanStatus, dirty: true }
      useWorktreeStatus.mockReturnValue(dirtyStatus)

      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      expect(screen.getByTestId('dot-icon')).toBeInTheDocument()
    })

    it('should render ahead badge with count', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      const aheadStatus: WorktreeStatus = { ...cleanStatus, ahead: 3 }
      useWorktreeStatus.mockReturnValue(aheadStatus)

      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      expect(screen.getByTestId('arrow-up')).toBeInTheDocument()
      expect(screen.getByText('↑3')).toBeInTheDocument()
    })

    it('should render behind badge with count', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      const behindStatus: WorktreeStatus = { ...cleanStatus, behind: 2 }
      useWorktreeStatus.mockReturnValue(behindStatus)

      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      expect(screen.getByTestId('arrow-down')).toBeInTheDocument()
      expect(screen.getByText('↓2')).toBeInTheDocument()
    })

    it('should render conflicted badge with warning icon', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      const conflictedStatus: WorktreeStatus = { ...cleanStatus, conflicted: true }
      useWorktreeStatus.mockReturnValue(conflictedStatus)

      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      expect(screen.getByTestId('warning')).toBeInTheDocument()
    })

    it('should render all status badges when all conditions are true', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      const allStatus: WorktreeStatus = {
        dirty: true,
        ahead: 5,
        behind: 1,
        conflicted: true,
        currentBranch: 'feature/auth',
        updatedAt: Date.now(),
      }
      useWorktreeStatus.mockReturnValue(allStatus)

      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      expect(screen.getByTestId('dot-icon')).toBeInTheDocument()
      expect(screen.getByTestId('arrow-up')).toBeInTheDocument()
      expect(screen.getByTestId('arrow-down')).toBeInTheDocument()
      expect(screen.getByTestId('warning')).toBeInTheDocument()
    })
  })

  describe('interactions', () => {
    it('should call onSelect when clicked', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      useWorktreeStatus.mockReturnValue(cleanStatus)

      const onSelect = vi.fn()
      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={onSelect} />)

      const worktreeItem = screen.getByRole('button')
      fireEvent.click(worktreeItem)

      expect(onSelect).toHaveBeenCalledWith(mockWorktree.id)
    })

    it('should apply active styles when isActive is true', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      useWorktreeStatus.mockReturnValue(cleanStatus)

      const { rerender } = render(
        <WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />
      )

      const worktreeItem = screen.getByRole('button')
      expect(worktreeItem).not.toHaveClass('bg-accent')

      rerender(<WorktreeItem worktree={mockWorktree} isActive={true} onSelect={vi.fn()} />)
      expect(worktreeItem).toHaveClass('bg-accent')
    })
  })

  describe('accessibility', () => {
    it('should have role="button"', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      useWorktreeStatus.mockReturnValue(cleanStatus)

      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      expect(screen.getByRole('button')).toBeInTheDocument()
    })

    it('should have aria-label with branch name and status', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      const dirtyStatus: WorktreeStatus = { ...cleanStatus, dirty: true }
      useWorktreeStatus.mockReturnValue(dirtyStatus)

      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      const worktreeItem = screen.getByRole('button')
      expect(worktreeItem).toHaveAttribute('aria-label', 'Worktree feature/auth, status: dirty')
    })
  })

  describe('keyboard navigation', () => {
    it('should call onSelect when Enter key is pressed', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      useWorktreeStatus.mockReturnValue(cleanStatus)

      const onSelect = vi.fn()
      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={onSelect} />)

      const worktreeItem = screen.getByRole('button')
      fireEvent.keyDown(worktreeItem, { key: 'Enter' })

      expect(onSelect).toHaveBeenCalledWith(mockWorktree.id)
    })

    it('should call onSelect when Space key is pressed', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      useWorktreeStatus.mockReturnValue(cleanStatus)

      const onSelect = vi.fn()
      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={onSelect} />)

      const worktreeItem = screen.getByRole('button')
      fireEvent.keyDown(worktreeItem, { key: ' ' })

      expect(onSelect).toHaveBeenCalledWith(mockWorktree.id)
    })

    it('should not call onSelect for other keys', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      useWorktreeStatus.mockReturnValue(cleanStatus)

      const onSelect = vi.fn()
      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={onSelect} />)

      const worktreeItem = screen.getByRole('button')
      fireEvent.keyDown(worktreeItem, { key: 'a' })

      expect(onSelect).not.toHaveBeenCalled()
    })
  })

  describe('action buttons', () => {
    it('should render action menu button', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      useWorktreeStatus.mockReturnValue(cleanStatus)

      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      expect(screen.getByTestId('more')).toBeInTheDocument()
    })
  })
})
