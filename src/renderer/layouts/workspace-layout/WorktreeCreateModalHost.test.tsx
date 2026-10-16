import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/NewWorktreeModal', () => ({
  NewWorktreeModal: ({
    isOpen,
    projectId,
    onClose
  }: {
    isOpen: boolean
    projectId: string
    onClose: () => void
  }) =>
    isOpen ? (
      <div data-testid="new-worktree-modal" data-project-id={projectId}>
        <button type="button" onClick={onClose}>
          close
        </button>
      </div>
    ) : null
}))

import { dispatchWorktreeEvent, WORKTREE_EVENTS } from '@/hooks/use-worktree-shortcuts'
import { WorktreeCreateModalHost } from './WorktreeCreateModalHost'

describe('WorktreeCreateModalHost (issue #1184)', () => {
  it('stays closed until the create shortcut fires', () => {
    render(<WorktreeCreateModalHost />)
    expect(screen.queryByTestId('new-worktree-modal')).not.toBeInTheDocument()
  })

  it('opens the modal for the project in the event, and closes again', () => {
    render(<WorktreeCreateModalHost />)

    act(() => dispatchWorktreeEvent(WORKTREE_EVENTS.OPEN_CREATE_MODAL, { projectId: 'p1' }))
    expect(screen.getByTestId('new-worktree-modal')).toHaveAttribute('data-project-id', 'p1')

    act(() => screen.getByRole('button', { name: 'close' }).click())
    expect(screen.queryByTestId('new-worktree-modal')).not.toBeInTheDocument()
  })

  it('ignores an event without a project id', () => {
    render(<WorktreeCreateModalHost />)
    act(() => dispatchWorktreeEvent(WORKTREE_EVENTS.OPEN_CREATE_MODAL, {}))
    expect(screen.queryByTestId('new-worktree-modal')).not.toBeInTheDocument()
  })

  it('stops listening once unmounted', () => {
    const { unmount } = render(<WorktreeCreateModalHost />)
    unmount()
    act(() => dispatchWorktreeEvent(WORKTREE_EVENTS.OPEN_CREATE_MODAL, { projectId: 'p1' }))
    expect(screen.queryByTestId('new-worktree-modal')).not.toBeInTheDocument()
  })
})
