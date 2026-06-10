import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitBranchPicker } from './GitBranchPicker'

const mockBranches = vi.fn()
const mockCheckout = vi.fn()
const mockCreateBranch = vi.fn()

vi.mock('@/lib/worktree-api', () => ({
  worktreeApi: {
    branches: (...args: unknown[]) => mockBranches(...args)
  }
}))

vi.mock('@/lib/git-api', () => ({
  gitApi: {
    checkoutBranch: (...args: unknown[]) => mockCheckout(...args),
    createBranch: (...args: unknown[]) => mockCreateBranch(...args)
  }
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({ updateProject: vi.fn() })
  )
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      activeTerminalId: 'terminal-1',
      updateTerminalGitBranch: vi.fn()
    })
  )
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

const defaultProps = {
  repoPath: '/repo',
  currentBranch: 'dev',
  projectId: 'project-1'
}

async function openPicker(): Promise<void> {
  fireEvent.click(screen.getByLabelText('Switch git branch'))
  await waitFor(() => {
    expect(mockBranches).toHaveBeenCalled()
  })
}

describe('GitBranchPicker', () => {
  beforeEach(() => {
    mockBranches.mockReset()
    mockCheckout.mockReset()
    mockCreateBranch.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('shows a load error with retry when branch listing fails', async () => {
    mockBranches.mockResolvedValue({
      success: false,
      error: 'Not a git repository.',
      code: 'NOT_A_GIT_REPO'
    })

    render(<GitBranchPicker {...defaultProps} />)
    await openPicker()

    expect(screen.getByText('This folder is not a git repository.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined()
    expect(screen.queryByText('No branches yet.')).toBeNull()
  })

  it('shows empty state when the repo has no local branches', async () => {
    mockBranches.mockResolvedValue({
      success: true,
      data: [{ name: 'origin/main', isRemote: true, isCurrent: false, hasOtherWorktree: false }]
    })

    render(<GitBranchPicker {...defaultProps} />)
    await openPicker()

    expect(screen.getByText('No branches yet.')).toBeDefined()
    expect(screen.queryByText('This folder is not a git repository.')).toBeNull()
  })

  it('shows search empty state when branches exist but none match', async () => {
    mockBranches.mockResolvedValue({
      success: true,
      data: [
        { name: 'dev', isRemote: false, isCurrent: true, hasOtherWorktree: false },
        { name: 'main', isRemote: false, isCurrent: false, hasOtherWorktree: false }
      ]
    })

    render(<GitBranchPicker {...defaultProps} />)
    await openPicker()

    fireEvent.change(screen.getByPlaceholderText('Search branches...'), {
      target: { value: 'feature' }
    })

    expect(screen.getByText('No branches match your search.')).toBeDefined()
    expect(screen.queryByText('No branches yet.')).toBeNull()
  })
})
