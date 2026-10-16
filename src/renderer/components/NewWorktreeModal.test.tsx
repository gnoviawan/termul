import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import { NewWorktreeModal } from './NewWorktreeModal'

const mocks = vi.hoisted(() => ({ create: vi.fn(), log: vi.fn() }))

vi.mock('@/lib/api', () => ({
  worktreeApi: {
    branches: vi.fn().mockResolvedValue({ success: true, data: [] }),
    create: mocks.create,
    createSymlinks: vi.fn()
  }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mocks.log }))
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }))

const initialProjects = useProjectStore.getState().projects

describe('NewWorktreeModal create failure', () => {
  beforeEach(() => {
    mocks.create.mockReset()
    mocks.log.mockReset()
    useProjectStore.setState({
      projects: [
        { id: 'p1', name: 'P', color: 'blue', path: '/work', isGitRepo: true, worktrees: [] }
      ]
    } as never)
  })
  afterEach(() => {
    cleanup()
    useProjectStore.setState({ projects: initialProjects })
  })

  it('writes one durable warn log with the host error code', async () => {
    mocks.create.mockResolvedValue({
      success: false,
      error: 'A branch with that name already exists.',
      code: 'BRANCH_EXISTS'
    })
    render(<NewWorktreeModal isOpen onClose={vi.fn()} projectId="p1" />)
    fireEvent.change(screen.getByPlaceholderText('e.g. try-new-hero'), {
      target: { value: 'try-hero' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create & open' }))

    await waitFor(() => expect(mocks.log).toHaveBeenCalledTimes(1))
    expect(mocks.log).toHaveBeenCalledWith({
      level: 'warn',
      source: 'newWorktreeModal.worktreeCreate',
      message: 'worktree create failed code=BRANCH_EXISTS'
    })
  })

  it('logs a thrown create as code=UNKNOWN only and still shows the error', async () => {
    mocks.create.mockRejectedValue(new Error('secret detail /home/me/repo'))
    render(<NewWorktreeModal isOpen onClose={vi.fn()} projectId="p1" />)
    fireEvent.change(screen.getByPlaceholderText('e.g. try-new-hero'), {
      target: { value: 'try-hero' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create & open' }))

    expect(await screen.findByText('Error: secret detail /home/me/repo')).toBeTruthy()
    expect(mocks.log).toHaveBeenCalledTimes(1)
    expect(mocks.log).toHaveBeenCalledWith({
      level: 'warn',
      source: 'newWorktreeModal.worktreeCreate',
      message: 'worktree create threw code=UNKNOWN'
    })
  })
})
