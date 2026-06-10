import type { BranchInfo } from '@shared/types/ipc.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitBranchPicker } from './GitBranchPicker'

const mockBranches = vi.fn()
const mockCheckout = vi.fn()
const mockCreateBranch = vi.fn()

type BranchLoadSuccess = {
  success: true
  data: BranchInfo[]
}

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

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
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

  it('ignores stale branch loads from a previous repo path', async () => {
    const firstLoad = deferred<BranchLoadSuccess>()
    const secondLoad = deferred<BranchLoadSuccess>()

    mockBranches.mockReturnValueOnce(firstLoad.promise).mockReturnValueOnce(secondLoad.promise)

    const { rerender } = render(<GitBranchPicker {...defaultProps} />)
    await openPicker()

    rerender(<GitBranchPicker {...defaultProps} repoPath="/next-repo" />)
    await waitFor(() => {
      expect(mockBranches).toHaveBeenCalledTimes(2)
    })

    firstLoad.resolve({
      success: true,
      data: [
        { name: 'old-repo-branch', isRemote: false, isCurrent: false, hasOtherWorktree: false }
      ]
    })
    secondLoad.resolve({
      success: true,
      data: [
        { name: 'next-repo-branch', isRemote: false, isCurrent: false, hasOtherWorktree: false }
      ]
    })

    expect(await screen.findByText('next-repo-branch')).toBeDefined()
    expect(screen.queryByText('old-repo-branch')).toBeNull()
  })

  it('disables branch creation while branches are loading', async () => {
    const load = deferred<BranchLoadSuccess>()
    mockBranches.mockReturnValue(load.promise)

    render(<GitBranchPicker {...defaultProps} />)
    await openPicker()

    expect(screen.getByRole('button', { name: 'Create and checkout new branch...' })).toBeDisabled()
  })

  it('disables branch creation when branch loading errors', async () => {
    mockBranches.mockResolvedValue({
      success: false,
      error: 'Not a git repository.',
      code: 'NOT_A_GIT_REPO'
    })

    render(<GitBranchPicker {...defaultProps} />)
    await openPicker()

    expect(screen.getByRole('button', { name: 'Create and checkout new branch...' })).toBeDisabled()
  })
})
