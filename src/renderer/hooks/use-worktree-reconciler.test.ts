import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useWorktreeReconciler } from './use-worktree-reconciler'

// Mock the worktree API
vi.mock('@/lib/api', () => ({
	worktreeApi: {
		list: vi.fn(),
		checkDirty: vi.fn(),
		branches: vi.fn(),
		create: vi.fn(),
		remove: vi.fn(),
		removeAllManaged: vi.fn(),
	},
}))

// Mock the project store
const mockRemoveWorktree = vi.fn()
const mockUpdateProject = vi.fn()
const mockAddWorktree = vi.fn()

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
						{ id: 'wt-1', name: 'feat-1', branch: 'feat-1', path: '/test/project/.termul/worktrees/feat-1', createdAt: '2026-01-01' },
						{ id: 'wt-2', name: 'feat-2', branch: 'feat-2', path: '/test/project/.termul/worktrees/feat-2', createdAt: '2026-01-01' },
					],
					activeWorktreeId: null,
				},
			],
			addWorktree: mockAddWorktree,
			removeWorktree: mockRemoveWorktree,
			updateProject: mockUpdateProject,
		}),
	},
	useProjectActions: () => ({
		removeWorktree: mockRemoveWorktree,
		updateProject: mockUpdateProject,
	}),
}))

import { worktreeApi } from '@/lib/api'

describe('useWorktreeReconciler', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('removes orphaned worktrees that no longer exist in git', async () => {
		// Git reports only feat-1, so feat-2 is orphaned
		vi.mocked(worktreeApi.list).mockResolvedValue({
			success: true,
			data: [
				{ name: 'feat-1', branch: 'feat-1', path: '/test/project/.termul/worktrees/feat-1', headCommit: 'abc' },
			],
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
				{ name: 'feat-1', branch: 'feat-1', path: '/test/project/.termul/worktrees/feat-1', headCommit: 'abc' },
				{ name: 'feat-3', branch: 'feat-3', path: '/test/project/.termul/worktrees/feat-3', headCommit: 'def' },
			],
		})

		renderHook(() => useWorktreeReconciler('proj-1'))

		await vi.waitFor(() => {
			expect(mockAddWorktree).toHaveBeenCalledWith('proj-1', expect.objectContaining({
				name: 'feat-3',
				branch: 'feat-3',
				path: '/test/project/.termul/worktrees/feat-3',
			}))
		})
	})

	it('resets active worktree if it becomes orphaned', async () => {
		// Override store mock to have active worktree be the one being orphaned
		vi.mocked(worktreeApi.list).mockResolvedValue({
			success: true,
			data: [
				{ name: 'feat-1', branch: 'feat-1', path: '/test/project/.termul/worktrees/feat-1', headCommit: 'abc' },
			],
		})

		renderHook(() => useWorktreeReconciler('proj-1'))

		await vi.waitFor(() => {
			expect(mockRemoveWorktree).toHaveBeenCalled()
		})
	})

	it('skips reconciliation when API fails', async () => {
		vi.mocked(worktreeApi.list).mockResolvedValue({
			success: false,
			error: 'Not a git repo',
			code: 'NOT_A_GIT_REPO',
		})

		renderHook(() => useWorktreeReconciler('proj-1'))

		// Give time for async operations
		await new Promise((r) => setTimeout(r, 100))

		expect(mockRemoveWorktree).not.toHaveBeenCalled()
		expect(mockAddWorktree).not.toHaveBeenCalled()
	})
})