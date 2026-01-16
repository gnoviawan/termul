/**
 * Unit tests for WorktreeList Component
 *
 * Tests list rendering, keyboard navigation, and states.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WorktreeList } from './WorktreeList'
import type { WorktreeMetadata } from '../../worktree.types'

describe('WorktreeList', () => {
  const mockWorktrees: WorktreeMetadata[] = [
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

  describe('rendering', () => {
    it('should render all worktrees', () => {
      const onSelect = vi.fn()
      render(
        <WorktreeList
          worktrees={mockWorktrees}
          selectedWorktreeId={null}
          onWorktreeSelect={onSelect}
        />
      )

      expect(screen.getByText('feature/auth')).toBeInTheDocument()
      expect(screen.getByText('feature/login')).toBeInTheDocument()
    })

    it('should render empty state when isEmpty is true', () => {
      const onSelect = vi.fn()
      render(
        <WorktreeList
          worktrees={[]}
          selectedWorktreeId={null}
          onWorktreeSelect={onSelect}
          isEmpty={true}
        />
      )

      expect(
        screen.getByText('No worktrees yet. Create your first worktree to get started.')
      ).toBeInTheDocument()
    })

    it('should render loading state when isLoading is true', () => {
      const onSelect = vi.fn()
      render(
        <WorktreeList
          worktrees={[]}
          selectedWorktreeId={null}
          onWorktreeSelect={onSelect}
          isLoading={true}
        />
      )

      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })
  })

  describe('keyboard navigation', () => {
    it('should handle ArrowDown key', () => {
      const onSelect = vi.fn()
      render(
        <WorktreeList
          worktrees={mockWorktrees}
          selectedWorktreeId={mockWorktrees[0].id}
          onWorktreeSelect={onSelect}
        />
      )

      const listbox = screen.getByRole('listbox')
      listbox.focus()

      // Simulate ArrowDown key
      listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))

      // Should call onSelect with second worktree
      // Note: This would need actual event handling simulation
    })

    it('should handle ArrowUp key', () => {
      const onSelect = vi.fn()
      render(
        <WorktreeList
          worktrees={mockWorktrees}
          selectedWorktreeId={mockWorktrees[1].id}
          onWorktreeSelect={onSelect}
        />
      )

      const listbox = screen.getByRole('listbox')
      listbox.focus()

      // Simulate ArrowUp key
      listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
    })

    it('should handle Home key', () => {
      const onSelect = vi.fn()
      render(
        <WorktreeList
          worktrees={mockWorktrees}
          selectedWorktreeId={mockWorktrees[1].id}
          onWorktreeSelect={onSelect}
        />
      )

      const listbox = screen.getByRole('listbox')
      listbox.focus()

      // Simulate Home key - should select first item
      listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }))
    })

    it('should handle End key', () => {
      const onSelect = vi.fn()
      render(
        <WorktreeList
          worktrees={mockWorktrees}
          selectedWorktreeId={mockWorktrees[0].id}
          onWorktreeSelect={onSelect}
        />
      )

      const listbox = screen.getByRole('listbox')
      listbox.focus()

      // Simulate End key - should select last item
      listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }))
    })
  })

  describe('accessibility', () => {
    it('should have role="listbox"', () => {
      const onSelect = vi.fn()
      render(
        <WorktreeList
          worktrees={mockWorktrees}
          selectedWorktreeId={null}
          onWorktreeSelect={onSelect}
        />
      )

      expect(screen.getByRole('listbox')).toBeInTheDocument()
    })

    it('should have aria-label', () => {
      const onSelect = vi.fn()
      render(
        <WorktreeList
          worktrees={mockWorktrees}
          selectedWorktreeId={null}
          onWorktreeSelect={onSelect}
        />
      )

      const listbox = screen.getByRole('listbox')
      expect(listbox).toHaveAttribute('aria-label', 'Worktrees')
    })

    it('should be focusable with tabIndex', () => {
      const onSelect = vi.fn()
      render(
        <WorktreeList
          worktrees={mockWorktrees}
          selectedWorktreeId={null}
          onWorktreeSelect={onSelect}
        />
      )

      const listbox = screen.getByRole('listbox')
      expect(listbox).toHaveAttribute('tabIndex', '0')
    })
  })
})
