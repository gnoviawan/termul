import type { BranchInfo } from '@shared/types/worktree.types'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import { ChatContextStrip } from './ChatContextStrip'

const mocks = vi.hoisted(() => ({
  admits: { value: true },
  branches: vi.fn(),
  checkout: vi.fn(),
  reconcile: vi.fn()
}))

vi.mock('@/hooks/use-server-admits-remote-writes', () => ({
  useServerAdmitsRemoteWrites: () => mocks.admits.value
}))
vi.mock('@/lib/worktree-api', () => ({
  worktreeApi: { branches: (...args: unknown[]) => mocks.branches(...args) }
}))
vi.mock('@/lib/git-api', () => ({
  gitApi: { checkoutBranch: (...args: unknown[]) => mocks.checkout(...args) }
}))
vi.mock('@/lib/worktree-reconciler', () => ({
  reconcileProjectWorktrees: (...args: unknown[]) => mocks.reconcile(...args)
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const BRANCHES: BranchInfo[] = [
  { name: 'main', isRemote: false, isCurrent: true, hasOtherWorktree: false },
  { name: 'dev', isRemote: false, isCurrent: false, hasOtherWorktree: false }
]

const initialProjects = useProjectStore.getState().projects

function seedProject(fields: Record<string, unknown> = {}): void {
  useProjectStore.setState({
    projects: [
      {
        id: 'p1',
        name: 'Project',
        color: 'blue',
        path: '/work',
        gitBranch: 'main',
        isGitRepo: true,
        ...fields
      }
    ]
  } as never)
}

const localSession = { projectId: 'p1', cwd: '/work' }
const worktreeSession = {
  projectId: 'p1',
  cwd: '/work/.termul/worktrees/abcd1234',
  worktreePath: '/work/.termul/worktrees/abcd1234',
  worktreeBranch: 'chat/abcd1234'
}

async function openPicker(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Switch git branch' }))
  await waitFor(() => expect(mocks.branches).toHaveBeenCalled())
}

describe('ChatContextStrip', () => {
  beforeEach(() => {
    mocks.admits.value = true
    mocks.branches.mockReset()
    mocks.branches.mockResolvedValue({ success: true, data: BRANCHES })
    mocks.checkout.mockReset()
    mocks.checkout.mockResolvedValue(undefined)
    mocks.reconcile.mockReset()
    mocks.reconcile.mockResolvedValue('updated')
    seedProject()
  })
  afterEach(() => {
    cleanup()
    useProjectStore.setState({ projects: initialProjects })
  })

  it('reads Current checkout with the branch picker at the chat cwd', async () => {
    render(<ChatContextStrip session={localSession} />)
    expect(screen.getByText('Current checkout')).toBeInTheDocument()
    expect(screen.queryByText('Local')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch git branch' })).toHaveTextContent('main')
    await openPicker()
    expect(mocks.branches).toHaveBeenCalledWith('/work')
  })

  it('refreshes the label through the project branch after a switch (current checkout)', async () => {
    render(<ChatContextStrip session={localSession} />)
    await openPicker()
    fireEvent.click((await screen.findByText('dev')).closest('button') as HTMLButtonElement)
    await waitFor(() => expect(mocks.checkout).toHaveBeenCalledWith('/work', 'dev', false))
    expect(useProjectStore.getState().projects[0].gitBranch).toBe('dev')
    expect(mocks.reconcile).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Switch git branch' })).toHaveTextContent('dev')
    )
  })

  it('reads Worktree and prefers the listed worktree branch over the launch branch', () => {
    seedProject({
      worktrees: [
        {
          id: 'w1',
          name: 'abcd1234',
          branch: 'feat/renamed',
          path: '/work/.termul/worktrees/abcd1234',
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    })
    render(<ChatContextStrip session={worktreeSession} />)
    expect(screen.getByText('Worktree')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch git branch' })).toHaveTextContent(
      'feat/renamed'
    )
  })

  it('falls back to the launch branch when the worktree is not listed', () => {
    render(<ChatContextStrip session={worktreeSession} />)
    expect(screen.getByRole('button', { name: 'Switch git branch' })).toHaveTextContent(
      'chat/abcd1234'
    )
  })

  it('reconciles worktrees, not the project branch, after a switch in a worktree chat', async () => {
    render(<ChatContextStrip session={worktreeSession} />)
    await openPicker()
    fireEvent.click((await screen.findByText('dev')).closest('button') as HTMLButtonElement)
    await waitFor(() => expect(mocks.reconcile).toHaveBeenCalledWith('p1'))
    expect(useProjectStore.getState().projects[0].gitBranch).toBe('main')
  })

  it('shows the new branch at once for an unresolved worktree until it is listed', async () => {
    render(<ChatContextStrip session={worktreeSession} />)
    await openPicker()
    fireEvent.click((await screen.findByText('dev')).closest('button') as HTMLButtonElement)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Switch git branch' })).toHaveTextContent('dev')
    )
    // Once the reconciler lists the worktree, its branch wins again.
    act(() =>
      seedProject({
        worktrees: [
          {
            id: 'w1',
            name: 'abcd1234',
            branch: 'dev-listed',
            path: '/work/.termul/worktrees/abcd1234',
            createdAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Switch git branch' })).toHaveTextContent(
        'dev-listed'
      )
    )
  })

  it('does not carry the override to another chat cwd', async () => {
    const { rerender } = render(<ChatContextStrip session={worktreeSession} />)
    await openPicker()
    fireEvent.click((await screen.findByText('dev')).closest('button') as HTMLButtonElement)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Switch git branch' })).toHaveTextContent('dev')
    )
    rerender(
      <ChatContextStrip
        session={{
          ...worktreeSession,
          cwd: '/work/.termul/worktrees/other',
          worktreePath: '/work/.termul/worktrees/other',
          worktreeBranch: 'chat/other'
        }}
      />
    )
    expect(screen.getByRole('button', { name: 'Switch git branch' })).toHaveTextContent(
      'chat/other'
    )
  })

  it('keeps the picker write gate on a read-only server', async () => {
    mocks.admits.value = false
    render(<ChatContextStrip session={localSession} />)
    await openPicker()
    const row = (await screen.findByText('dev')).closest('button') as HTMLButtonElement
    expect(row).toBeDisabled()
    await act(async () => {
      fireEvent.click(row)
    })
    expect(mocks.checkout).not.toHaveBeenCalled()
  })

  it('keeps the plain read-only strip for a project that is not a git repo', () => {
    seedProject({ isGitRepo: false, gitBranch: undefined })
    render(<ChatContextStrip session={localSession} />)
    expect(screen.getByText('Current checkout')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Switch git branch' })).not.toBeInTheDocument()
  })
})
