import type { BranchInfo } from '@shared/types/worktree.types'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectNotWriteGated, expectWriteGated } from '@/lib/test-utils/write-gate'

const admits = vi.hoisted(() => ({ value: false }))
vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => admits.value
}))

const mockBranches = vi.fn()
const mockCheckout = vi.fn()
const mockCreateBranch = vi.fn()

vi.mock('@/lib/worktree-api', () => ({
  worktreeApi: { branches: (...args: unknown[]) => mockBranches(...args) }
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
    selector({ activeTerminalId: 'terminal-1', updateTerminalGitBranch: vi.fn() })
  )
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { GitBranchPicker } from './GitBranchPicker'

const BRANCHES: BranchInfo[] = [
  { name: 'dev', isRemote: false, isCurrent: true, hasOtherWorktree: false },
  { name: 'feature', isRemote: false, isCurrent: false, hasOtherWorktree: false }
]

async function openPicker(): Promise<void> {
  render(<GitBranchPicker repoPath="/repo" currentBranch="dev" projectId="project-1" />)
  // The trigger stays enabled so branches remain viewable on a read-only server.
  const trigger = screen.getByLabelText('Switch git branch')
  expect(trigger).not.toBeDisabled()
  fireEvent.click(trigger)
  await screen.findByText('feature')
}

describe('GitBranchPicker write gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    admits.value = false
    mockBranches.mockResolvedValue({ success: true, data: BRANCHES })
    mockCheckout.mockResolvedValue(undefined)
    mockCreateBranch.mockResolvedValue(undefined)
  })

  it('branch checkout row is disabled with the read-only reason on a read-only server', async () => {
    await openPicker()
    const row = screen.getByText('feature').closest('button') as HTMLButtonElement
    expectWriteGated(row)
    fireEvent.click(row)
    expect(mockCheckout).not.toHaveBeenCalled()
  })

  it('branch checkout row stays enabled and unwrapped when writes are admitted', async () => {
    admits.value = true
    await openPicker()
    const row = screen.getByText('feature').closest('button') as HTMLButtonElement
    expectNotWriteGated(row)
    fireEvent.click(row)
    await waitFor(() => expect(mockCheckout).toHaveBeenCalledWith('/repo', 'feature', false))
  })

  it('create branch is disabled with the read-only reason on a read-only server', async () => {
    await openPicker()
    const create = screen.getByRole('button', { name: /Create branch from/ })
    expectWriteGated(create)
    fireEvent.click(create)
    expect(screen.queryByLabelText('New branch name')).not.toBeInTheDocument()
    expect(mockCreateBranch).not.toHaveBeenCalled()
  })

  it('create branch stays enabled and unwrapped when writes are admitted', async () => {
    admits.value = true
    await openPicker()
    const create = screen.getByRole('button', { name: /Create branch from/ })
    expectNotWriteGated(create)
    fireEvent.click(create)
    expect(screen.getByLabelText('New branch name')).toBeInTheDocument()
  })
})
