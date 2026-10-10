import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorktreeReconciler } from './use-worktree-reconciler'

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(),
  ensureSymlinks: vi.fn(),
  isTauri: { value: true },
  project: {
    id: 'proj-1',
    name: 'Test',
    path: '/test/project',
    isGitRepo: true as boolean,
    symlinkDirs: undefined as string[] | undefined,
    worktrees: [
      { id: 'wt-1', name: 'a', branch: 'a', path: '/test/project/.termul/worktrees/a' },
      { id: 'wt-2', name: 'b', branch: 'b', path: '/test/project/.termul/worktrees/b' }
    ]
  }
}))

vi.mock('@/lib/worktree-reconciler', () => ({
  reconcileProjectWorktrees: mocks.reconcile
}))

vi.mock('@/lib/worktree-api', () => ({
  worktreeApi: { ensureSymlinks: mocks.ensureSymlinks }
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => mocks.isTauri.value
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: {
    getState: () => ({ projects: [mocks.project] })
  }
}))

describe('useWorktreeReconciler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.isTauri.value = true
    mocks.project.isGitRepo = true
    mocks.project.symlinkDirs = undefined
    mocks.reconcile.mockResolvedValue('unchanged')
    mocks.ensureSymlinks.mockResolvedValue({ success: true, data: [] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reconciles on mount and on every 60s interval tick', async () => {
    const { unmount } = renderHook(() => useWorktreeReconciler('proj-1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.reconcile).toHaveBeenCalledTimes(1)
    expect(mocks.reconcile).toHaveBeenCalledWith('proj-1')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.reconcile).toHaveBeenCalledTimes(2)

    unmount()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mocks.reconcile).toHaveBeenCalledTimes(2)
  })

  it('runs on web too (no isTauriContext early return) without touching symlinks', async () => {
    mocks.isTauri.value = false
    mocks.project.symlinkDirs = ['node_modules']
    renderHook(() => useWorktreeReconciler('proj-1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.reconcile).toHaveBeenCalledWith('proj-1')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.reconcile).toHaveBeenCalledTimes(2)
    expect(mocks.ensureSymlinks).not.toHaveBeenCalled()
  })

  it('ensures symlinks for each stored worktree on desktop after reconciling', async () => {
    mocks.project.symlinkDirs = ['node_modules']
    renderHook(() => useWorktreeReconciler('proj-1'))
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.ensureSymlinks).toHaveBeenCalledTimes(2)
    expect(mocks.ensureSymlinks).toHaveBeenCalledWith(
      '/test/project',
      '/test/project/.termul/worktrees/a',
      ['node_modules']
    )
    expect(mocks.ensureSymlinks).toHaveBeenCalledWith(
      '/test/project',
      '/test/project/.termul/worktrees/b',
      ['node_modules']
    )
  })

  it('skips symlinks when no symlink dirs are configured or the project is not a git repo', async () => {
    renderHook(() => useWorktreeReconciler('proj-1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.ensureSymlinks).not.toHaveBeenCalled()

    mocks.project.symlinkDirs = ['node_modules']
    mocks.project.isGitRepo = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.ensureSymlinks).not.toHaveBeenCalled()
  })

  it('swallows a failing symlink ensure and keeps going', async () => {
    mocks.project.symlinkDirs = ['node_modules']
    mocks.ensureSymlinks.mockRejectedValue(new Error('boom'))
    renderHook(() => useWorktreeReconciler('proj-1'))
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.ensureSymlinks).toHaveBeenCalledTimes(2)
  })
})
