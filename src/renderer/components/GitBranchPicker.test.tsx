import type { BranchInfo } from '@shared/types/worktree.types'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitBranchPicker } from './GitBranchPicker'

// Write controls are gated on a read-only server; these tests cover the admitted path.
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => true
}))

const mockBranches = vi.fn()
const mockCheckout = vi.fn()
const mockCreateBranch = vi.fn()
const mockUpdateProject = vi.fn()
const mockUpdateTerminalGitBranch = vi.fn()

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
    selector({ updateProject: mockUpdateProject })
  )
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({
      activeTerminalId: 'terminal-1',
      updateTerminalGitBranch: mockUpdateTerminalGitBranch
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
    mockUpdateProject.mockReset()
    mockUpdateTerminalGitBranch.mockReset()
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

  it('lists remote branches when the repo has no local branches', async () => {
    mockBranches.mockResolvedValue({
      success: true,
      data: [{ name: 'origin/main', isRemote: true, isCurrent: false, hasOtherWorktree: false }]
    })

    render(<GitBranchPicker {...defaultProps} />)
    await openPicker()

    expect(screen.getByText('origin/main')).toBeDefined()
    expect(screen.getByText('Remote')).toBeDefined()
    expect(screen.queryByText('No branches yet.')).toBeNull()
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

    fireEvent.change(screen.getByPlaceholderText('Search branches'), {
      target: { value: 'feature' }
    })

    expect(screen.getByText('No branches match your search.')).toBeDefined()
    expect(screen.queryByText('No branches yet.')).toBeNull()
  })

  it('lists remote-only branches with a remote tag', async () => {
    mockBranches.mockResolvedValue({
      success: true,
      data: [
        { name: 'dev', isRemote: false, isCurrent: true, hasOtherWorktree: false },
        {
          name: 'origin/feat/git-history-graph',
          isRemote: true,
          isCurrent: false,
          hasOtherWorktree: false
        }
      ]
    })

    render(<GitBranchPicker {...defaultProps} />)
    await openPicker()

    // Remote-only branch should appear in the list alongside local branches
    await waitFor(() => {
      expect(screen.getByText('origin/feat/git-history-graph')).toBeDefined()
    })
    expect(screen.getByText('Remote')).toBeDefined()
    expect(screen.queryByText('No branches yet.')).toBeNull()
  })

  it('checks out a remote branch with isRemote=true and strips prefix in toast', async () => {
    mockBranches.mockResolvedValue({
      success: true,
      data: [
        { name: 'dev', isRemote: false, isCurrent: true, hasOtherWorktree: false },
        {
          name: 'origin/feature',
          isRemote: true,
          isCurrent: false,
          hasOtherWorktree: false
        }
      ]
    })

    mockCheckout.mockResolvedValue(undefined)

    render(<GitBranchPicker {...defaultProps} />)
    await openPicker()

    await waitFor(() => {
      expect(screen.getByText('origin/feature')).toBeDefined()
    })

    fireEvent.click(screen.getByText('origin/feature'))

    await waitFor(() => {
      expect(mockCheckout).toHaveBeenCalledWith('/repo', 'origin/feature', true)
    })
  })

  it('records the branch on the project and active terminal by default', async () => {
    mockBranches.mockResolvedValue({
      success: true,
      data: [
        { name: 'dev', isRemote: false, isCurrent: true, hasOtherWorktree: false },
        { name: 'feature', isRemote: false, isCurrent: false, hasOtherWorktree: false }
      ]
    })
    mockCheckout.mockResolvedValue(undefined)

    render(<GitBranchPicker {...defaultProps} />)
    await openPicker()
    fireEvent.click(await screen.findByText('feature'))

    await waitFor(() => {
      expect(mockUpdateProject).toHaveBeenCalledWith('project-1', { gitBranch: 'feature' })
    })
    expect(mockUpdateTerminalGitBranch).toHaveBeenCalledWith('terminal-1', 'feature')
  })

  it('hands the new branch to onBranchChanged instead of writing project or terminal', async () => {
    const onBranchChanged = vi.fn()
    mockBranches.mockResolvedValue({
      success: true,
      data: [
        { name: 'dev', isRemote: false, isCurrent: true, hasOtherWorktree: false },
        { name: 'feature', isRemote: false, isCurrent: false, hasOtherWorktree: false }
      ]
    })
    mockCheckout.mockResolvedValue(undefined)

    render(<GitBranchPicker {...defaultProps} onBranchChanged={onBranchChanged} />)
    await openPicker()
    fireEvent.click(await screen.findByText('feature'))

    await waitFor(() => {
      expect(onBranchChanged).toHaveBeenCalledWith('feature')
    })
    expect(mockUpdateProject).not.toHaveBeenCalled()
    expect(mockUpdateTerminalGitBranch).not.toHaveBeenCalled()
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

    expect(screen.getByRole('button', { name: 'Create branch from dev' })).toBeDisabled()
  })

  it('disables branch creation when branch loading errors', async () => {
    mockBranches.mockResolvedValue({
      success: false,
      error: 'Not a git repository.',
      code: 'NOT_A_GIT_REPO'
    })

    render(<GitBranchPicker {...defaultProps} />)
    await openPicker()

    expect(screen.getByRole('button', { name: 'Create branch from dev' })).toBeDisabled()
  })

  it('groups branches into Local and Remote and marks the current one with a check', async () => {
    mockBranches.mockResolvedValue({
      success: true,
      data: [
        { name: 'dev', isRemote: false, isCurrent: true, hasOtherWorktree: false },
        { name: 'feature', isRemote: false, isCurrent: false, hasOtherWorktree: false },
        { name: 'origin/release', isRemote: true, isCurrent: false, hasOtherWorktree: false }
      ]
    })

    render(<GitBranchPicker {...defaultProps} />)
    await openPicker()

    const local = await screen.findByRole('group', { name: 'Local branches' })
    const remote = screen.getByRole('group', { name: 'Remote branches' })
    expect(within(local).getByText('dev')).toBeDefined()
    expect(within(local).getByText('feature')).toBeDefined()
    expect(within(remote).getByText('origin/release')).toBeDefined()

    const current = within(local).getByText('dev').closest('button')
    expect(current).toHaveAttribute('aria-current', 'true')
    expect(within(current as HTMLElement).getByLabelText('Current branch')).toBeDefined()
    expect(current?.className).not.toContain('bg-accent')
  })

  it('shows the open state on the trigger while the popover is open', async () => {
    mockBranches.mockResolvedValue({ success: true, data: [] })
    render(<GitBranchPicker {...defaultProps} />)
    await openPicker()
    const trigger = screen.getByLabelText('Switch git branch')
    expect(trigger).toHaveAttribute('data-state', 'open')
    expect(trigger.className).toContain('data-[state=open]:bg-foreground/[0.06]')
  })

  describe('strip variant', () => {
    it('renders the strip trigger look without ahead/behind and keeps the same popover', async () => {
      mockBranches.mockResolvedValue({
        success: true,
        data: [{ name: 'dev', isRemote: false, isCurrent: true, hasOtherWorktree: false }]
      })
      render(<GitBranchPicker {...defaultProps} ahead={2} behind={1} variant="strip" />)
      const trigger = screen.getByLabelText('Switch git branch')
      expect(trigger.className).toContain('h-7')
      expect(trigger.className).toContain('text-muted-foreground')
      expect(trigger).toHaveTextContent('dev')
      expect(trigger).not.toHaveTextContent('2')
      await openPicker()
      expect(screen.getByLabelText('Search branches')).toBeDefined()
      expect(screen.getByRole('button', { name: /Create branch from/ })).toBeDefined()
    })

    it('labels a detached HEAD on the strip and leaves the default variant unchanged', () => {
      const { rerender } = render(
        <GitBranchPicker {...defaultProps} currentBranch={null} variant="strip" />
      )
      expect(screen.getByLabelText('Switch git branch')).toHaveTextContent('Detached HEAD')
      rerender(<GitBranchPicker {...defaultProps} currentBranch={null} ahead={3} />)
      const trigger = screen.getByLabelText('Switch git branch')
      expect(trigger).toHaveTextContent('detached')
      expect(trigger).toHaveTextContent('↑3')
      expect(trigger.className).not.toContain('h-7')
    })
  })
})
