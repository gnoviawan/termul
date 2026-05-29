/**
 * Worktree search and filter utilities.
 *
 * Provides search, status filtering, and branch name filtering
 * for managing large worktree collections.
 */

import type { Worktree } from '@/types/project'
import type { WorktreeHealthStatus } from '@/types/worktree-status'

export interface WorktreeFilterOptions {
	/** Search query for branch name matching */
	searchQuery?: string
	/** Filter by health status */
	statusFilter?: WorktreeHealthStatus | 'all'
	/** Filter by branch name pattern */
	branchPattern?: string
}

/**
 * Filter worktrees based on search and filter options.
 */
export function filterWorktrees(
	worktrees: Worktree[],
	options: WorktreeFilterOptions,
	statusMap?: Map<string, WorktreeHealthStatus>,
): Worktree[] {
	let result = worktrees

	// Search by branch name
	if (options.searchQuery) {
		const query = options.searchQuery.toLowerCase()
		result = result.filter((wt) =>
			wt.name.toLowerCase().includes(query) ||
			wt.branch.toLowerCase().includes(query),
		)
	}

	// Filter by status
	if (options.statusFilter && options.statusFilter !== 'all' && statusMap) {
		result = result.filter((wt) => {
			const status = statusMap.get(wt.id)
			return status === options.statusFilter
		})
	}

	// Filter by branch pattern
	if (options.branchPattern) {
		result = result.filter((wt) =>
			wt.branch.startsWith(options.branchPattern!),
		)
	}

	return result
}

/**
 * Check if search UI should be shown (10+ worktrees threshold).
 */
export function shouldShowSearch(worktreeCount: number): boolean {
	return worktreeCount >= 10
}