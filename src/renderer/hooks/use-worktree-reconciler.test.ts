import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorktreeReconciler } from './use-worktree-reconciler'

// Mock variables are hoisted so they are available inside vi.mock() factories
// (vitest hoists vi.mock above all imports and top-level declarations).
const mocks = vi.hoisted(() => ({
  removeWorktree: vi.fn(),
  updateProject: vi.fn(),
  addWorktree: vi.fn(),
  reconcileNow: vi.fn(),
  // Mutable per-scenario state, read live inside the mocked store's getState().
  state: {
    activeWorktreeId: null as string | null,
    isGitRepo: true
  }
}))

// Mock the worktree API
vi.mock('@/lib/api', () => ({
  worktreeApi: {
    list: vi.fn(),
    checkDirty: vi.fn(),
    branches: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    removeAllManaged: vi.fn()
  }
}))

// Shared reconciler (re-checks `git worktree list` and flips isGitRepo). Mocked so
// tests can assert it is invoked and simulate the heal side-effect.
vi.mock('@/hooks/use-projects-persistence', () => ({
  reconcileProjectWorktreesNow: mocks.reconcileNow
}))

// Mock the project store
vi.mock('@/stores/project-store', () => ({
  useProjectStore: {
    getState: () => ({
      projects: [
        {
          id: 'proj-1',
          name: 'Test',
          path: '/test/project',
          isGitRepo: mocks.state.isGitRepo,
          worktrees: [
            {
              id: 'wt-1',
              name: 'feat-1',
              branch: 'feat-1',
              path: '/test/project/.termul/worktrees/feat-1',
              createdAt: '2026-01-01'
            },
            {
              id: 'wt-2',
              name: 'feat-2',
              branch: 'feat-2',
              path: '/test/project/.termul/worktrees/feat-2',
              createdAt: '2026-01-01'
            }
          ],
          activeWorktreeId: mocks.state.activeWorktreeId
        }
      ],
      addWorktree: mocks.addWorktree,
      removeWorktree: mocks.removeWorktree,
      updateProject: mocks.updateProject
    })
  },
  useProjectActions: () => ({
    removeWorktree: mocks.removeWorktree,
    updateProject: mocks.updateProject
  })
}))

import { worktreeApi } from '@/lib/api'

describe('useWorktreeReconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeWorktreeId = null
    mocks.state.isGitRepo = true
  })

  it('removes orphaned worktrees that no longer exist in git', async () => {
    // Git reports only feat-1, so feat-2 is orphaned
    vi.mocked(worktreeApi.list).mockResolvedValue({
      success: true,
      data: [
        {
          name: 'feat-1',
          branch: 'feat-1',
          path: '/test/project/.termul/worktrees/feat-1',
          headCommit: 'abc'
        }
      ]
    })

    renderHook(() => useWorktreeReconciler('proj-1'))

    // Wait for async reconciliation
    await vi.waitFor(() => {
      expect(mocks.removeWorktree).toHaveBeenCalledWith('proj-1', 'wt-2')
    })
  })

  it('discovers new worktrees from git not yet in store', async () => {
    // Git reports feat-1 plus a new feat-3
    vi.mocked(worktreeApi.list).mockResolvedValue({
      success: true,
      data: [
        {
          name: 'feat-1',
          branch: 'feat-1',
          path: '/test/project/.termul/worktrees/feat-1',
          headCommit: 'abc'
        },
        {
          name: 'feat-3',
          branch: 'feat-3',
          path: '/test/project/.termul/worktrees/feat-3',
          headCommit: 'def'
        }
      ]
    })

    renderHook(() => useWorktreeReconciler('proj-1'))

    await vi.waitFor(() => {
      expect(mocks.addWorktree).toHaveBeenCalledWith(
        'proj-1',
        expect.objectContaining({
          name: 'feat-3',
          branch: 'feat-3',
          path: '/test/project/.termul/worktrees/feat-3'
        })
      )
    })
  })

  it('resets active worktree if it becomes orphaned', async () => {
    // Set active worktree to the one that will be orphaned by git (only feat-1 remains)
    mocks.state.activeWorktreeId = 'wt-2'

    vi.mocked(worktreeApi.list).mockResolvedValue({
      success: true,
      data: [
        {
          name: 'feat-1',
          branch: 'feat-1',
          path: '/test/project/.termul/worktrees/feat-1',
          headCommit: 'abc'
        }
      ]
    })

    renderHook(() => useWorktreeReconciler('proj-1'))

    await vi.waitFor(() => {
      expect(mocks.removeWorktree).toHaveBeenCalledWith('proj-1', 'wt-2')
      expect(mocks.updateProject).toHaveBeenCalledWith('proj-1', { activeWorktreeId: null })
    })
  })

  it('skips reconciliation when API fails', async () => {
    vi.mocked(worktreeApi.list).mockResolvedValue({
      success: false,
      error: 'Not a git repo',
      code: 'NOT_A_GIT_REPO'
    })

    renderHook(() => useWorktreeReconciler('proj-1'))

    // Wait for async operations
    await vi.waitFor(() => {
      expect(mocks.removeWorktree).not.toHaveBeenCalled()
      expect(mocks.addWorktree).not.toHaveBeenCalled()
    })
  })

  it('self-heals a project wrongly marked as non-git (re-runs git detection)', async () => {
    // A project can be flagged non-git when git was not available at first detection
    // (e.g. GUI app PATH differs from the shell at startup).
    mocks.state.isGitRepo = false
    // The shared reconciler re-runs `git worktree list`; simulate the heal side-effect.
    mocks.reconcileNow.mockImplementation(async () => {
      mocks.state.isGitRepo = true
    })

    renderHook(() => useWorktreeReconciler('proj-1'))

    await vi.waitFor(() => {
      expect(mocks.reconcileNow).toHaveBeenCalledWith('proj-1')
    })
  })

  it('heals a project flagged as a git repo after .git is removed', async () => {
    // Project is marked a repo, but git now reports it is not a repository anymore.
    vi.mocked(worktreeApi.list).mockResolvedValue({
      success: false,
      error: 'Not a git repo',
      code: 'NOT_A_GIT_REPO'
    })

    renderHook(() => useWorktreeReconciler('proj-1'))

    await vi.waitFor(() => {
      expect(mocks.updateProject).toHaveBeenCalledWith('proj-1', { isGitRepo: false })
    })
  })
})
