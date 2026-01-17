/**
 * Unit tests for WorktreeItem Component
 *
 * Tests worktree item rendering, status dots, and keyboard interactions.
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

// Mock cn utility
vi.mock('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}))

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  MoreVertical: () => <span data-testid="more">⋮</span>,
  Check: () => <span data-testid="check">✓</span>,
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

    it('should have compact layout (no subtitle, no freshness indicator)', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      useWorktreeStatus.mockReturnValue(cleanStatus)

      render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      // Should not have freshness indicator
      expect(screen.queryByTestId('freshness')).not.toBeInTheDocument()
      // Should only have branch name and status dots
      expect(screen.getByText('feature/auth')).toBeInTheDocument()
    })
  })

  describe('StatusDots component', () => {
    it('should render green dot for clean status', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      useWorktreeStatus.mockReturnValue(cleanStatus)

      const { container } = render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      // Green dot for clean status
      const greenDots = container.querySelectorAll('.bg-green-500')
      expect(greenDots.length).toBe(1)
    })

    it('should render orange dot for dirty status', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      const dirtyStatus: WorktreeStatus = { ...cleanStatus, dirty: true }
      useWorktreeStatus.mockReturnValue(dirtyStatus)

      const { container } = render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      // Orange dot for dirty status
      const orangeDots = container.querySelectorAll('.bg-orange-400')
      expect(orangeDots.length).toBe(1)
    })

    it('should render red dot for conflicted status', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      const conflictedStatus: WorktreeStatus = { ...cleanStatus, conflicted: true }
      useWorktreeStatus.mockReturnValue(conflictedStatus)

      const { container } = render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      // Red dot for conflicted status
      const redDots = container.querySelectorAll('.bg-red-500')
      expect(redDots.length).toBe(1)
    })

    it('should render yellow dot for ahead status', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      const aheadStatus: WorktreeStatus = { ...cleanStatus, ahead: 3 }
      useWorktreeStatus.mockReturnValue(aheadStatus)

      const { container } = render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      // Yellow dot for ahead status
      const yellowDots = container.querySelectorAll('.bg-yellow-500')
      expect(yellowDots.length).toBe(1)
    })

    it('should render cyan dot for behind status', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      const behindStatus: WorktreeStatus = { ...cleanStatus, behind: 2 }
      useWorktreeStatus.mockReturnValue(behindStatus)

      const { container } = render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      // Cyan dot for behind status
      const cyanDots = container.querySelectorAll('.bg-cyan-500')
      expect(cyanDots.length).toBe(1)
    })

    it('should render multiple dots when multiple conditions apply', () => {
      const { useWorktreeStatus } = require('@/stores/worktree-store')
      const multipleStatus: WorktreeStatus = {
        dirty: true,
        ahead: 5,
        behind: 0,
        conflicted: false,
        currentBranch: 'feature/auth',
        updatedAt: Date.now(),
      }
      useWorktreeStatus.mockReturnValue(multipleStatus)

      const { container } = render(<WorktreeItem worktree={mockWorktree} isActive={false} onSelect={vi.fn()} />)

      // Orange dot for dirty, yellow dot for ahead
      const orangeDots = container.querySelectorAll('.bg-orange-400')
      const yellowDots = container.querySelectorAll('.bg-yellow-500')
      expect(orangeDots.length).toBe(1)
      expect(yellowDots.length).toBe(1)
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
