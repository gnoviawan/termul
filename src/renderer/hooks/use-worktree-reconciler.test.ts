import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorktreeReconciler } from './use-worktree-reconciler'

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

// Mock the project store
const mockRemoveWorktree = vi.fn()
const mockUpdateProject = vi.fn()
const mockAddWorktree = vi.fn()

// Mutable activeWorktreeId — tests can override this per-scenario
let mockActiveWorktreeId: string | null = null

vi.mock('@/stores/project-store', () => ({
  useProjectStore: {
    getState: () => ({
      projects: [
        {
          id: 'proj-1',
          name: 'Test',
          path: '/test/project',
          isGitRepo: true,
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
          activeWorktreeId: mockActiveWorktreeId
        }
      ],
      addWorktree: mockAddWorktree,
      removeWorktree: mockRemoveWorktree,
      updateProject: mockUpdateProject
    })
  },
  useProjectActions: () => ({
    removeWorktree: mockRemoveWorktree,
    updateProject: mockUpdateProject
  })
}))

import { worktreeApi } from '@/lib/api'

describe('useWorktreeReconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockActiveWorktreeId = null
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
      expect(mockRemoveWorktree).toHaveBeenCalledWith('proj-1', 'wt-2')
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
      expect(mockAddWorktree).toHaveBeenCalledWith(
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
    mockActiveWorktreeId = 'wt-2'

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
      expect(mockRemoveWorktree).toHaveBeenCalledWith('proj-1', 'wt-2')
      expect(mockUpdateProject).toHaveBeenCalledWith('proj-1', { activeWorktreeId: null })
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
      expect(mockRemoveWorktree).not.toHaveBeenCalled()
      expect(mockAddWorktree).not.toHaveBeenCalled()
    })
  })
})
