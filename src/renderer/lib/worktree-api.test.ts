import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the Tauri invoke function
const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}))

// Import after mocking
import { worktreeApi } from './worktree-api'

describe('worktreeApi', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe('list', () => {
		it('calls invoke with worktree_list and projectPath', async () => {
			const mockResult = {
				success: true,
				data: [
					{
						name: 'main',
						branch: 'main',
						path: '/project',
						headCommit: 'abc1234',
					},
				],
			}
			mockInvoke.mockResolvedValue(mockResult)

			const result = await worktreeApi.list('/test/project')

			expect(mockInvoke).toHaveBeenCalledWith('worktree_list', {
				projectPath: '/test/project',
			})
			expect(result).toEqual(mockResult)
		})

		it('handles error response', async () => {
			const mockError = {
				success: false,
				error: 'Not a git repository.',
				code: 'NOT_A_GIT_REPO',
			}
			mockInvoke.mockResolvedValue(mockError)

			const result = await worktreeApi.list('/not/a/repo')

			expect(result.success).toBe(false)
			expect(result.success === false && result.code).toBe('NOT_A_GIT_REPO')
		})
	})

	describe('create', () => {
		it('calls invoke with worktree_create and all params', async () => {
			const mockResult = {
				success: true,
				data: {
					name: 'feat-1',
					branch: 'feat-1',
					path: '/project/.termul/worktrees/feat-1',
					headCommit: 'def5678',
				},
			}
			mockInvoke.mockResolvedValue(mockResult)

			const result = await worktreeApi.create({
				projectPath: '/test/project',
				name: 'feat-1',
				branch: 'feat-1',
				isNewBranch: true,
				startRef: 'main',
			})

			expect(mockInvoke).toHaveBeenCalledWith('worktree_create', {
				projectPath: '/test/project',
				name: 'feat-1',
				branch: 'feat-1',
				isNewBranch: true,
				startRef: 'main',
			})
			expect(result.success).toBe(true)
			expect(result.success === true && result.data?.name).toBe('feat-1')
		})
	})

	describe('remove', () => {
		it('calls invoke with worktree_remove and path', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: null })

			const result = await worktreeApi.remove('/project/.termul/worktrees/feat-1', false)

			expect(mockInvoke).toHaveBeenCalledWith('worktree_remove', {
				worktreePath: '/project/.termul/worktrees/feat-1',
				force: false,
			})
			expect(result.success).toBe(true)
		})

		it('passes force=true when requested', async () => {
			mockInvoke.mockResolvedValue({ success: true, data: null })

			await worktreeApi.remove('/project/.termul/worktrees/feat-1', true)

			expect(mockInvoke).toHaveBeenCalledWith('worktree_remove', {
				worktreePath: '/project/.termul/worktrees/feat-1',
				force: true,
			})
		})
	})

	describe('branches', () => {
		it('calls invoke with worktree_branches', async () => {
			const mockResult = {
				success: true,
				data: [
					{ name: 'main', isRemote: false, isCurrent: true, upstream: 'origin/main' },
					{ name: 'feat-1', isRemote: false, isCurrent: false, upstream: null },
				],
			}
			mockInvoke.mockResolvedValue(mockResult)

			const result = await worktreeApi.branches('/test/project')

			expect(mockInvoke).toHaveBeenCalledWith('worktree_branches', {
				projectPath: '/test/project',
			})
			expect(result.success === true && result.data ? result.data : []).toHaveLength(2)
		})
	})

	describe('checkDirty', () => {
		it('calls invoke with worktree_check_dirty', async () => {
			const mockResult = {
				success: true,
				data: { modified: 3, staged: 1, untracked: 2, hasChanges: true },
			}
			mockInvoke.mockResolvedValue(mockResult)

			const result = await worktreeApi.checkDirty('/project/.termul/worktrees/feat-1')

			expect(mockInvoke).toHaveBeenCalledWith('worktree_check_dirty', {
				worktreePath: '/project/.termul/worktrees/feat-1',
			})
			if (result.success) {
				expect(result.data.hasChanges).toBe(true)
				expect(result.data.modified).toBe(3)
			}
		})
	})

	describe('removeAllManaged', () => {
		it('calls invoke with worktree_remove_all_managed', async () => {
			const worktreesJson = JSON.stringify([
				{ id: '1', name: 'feat-1', branch: 'feat-1', path: '/project/.termul/worktrees/feat-1', createdAt: '2026-01-01' },
			])
			const mockResult = {
				success: true,
				data: [
					{ worktreePath: '/project/.termul/worktrees/feat-1', success: true, error: null },
				],
			}
			mockInvoke.mockResolvedValue(mockResult)

			const result = await worktreeApi.removeAllManaged('/test/project', JSON.parse(worktreesJson))

			expect(mockInvoke).toHaveBeenCalledWith('worktree_remove_all_managed', {
				projectPath: '/test/project',
				worktreesJson,
			})
			if (result.success) {
				expect(result.data).toHaveLength(1)
				expect(result.data[0].success).toBe(true)
			}
		})
	})
})
