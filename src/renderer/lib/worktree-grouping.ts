/**
 * Worktree grouping logic.
 *
 * Groups worktrees by branch prefix patterns (feature/*, bugfix/*, hotfix/*)
 * and supports custom user-defined groups.
 */

import type { Worktree } from '@/types/project'

export interface WorktreeGroup {
	id: string
	name: string
	pattern: string // glob pattern like "feature/*"
	color?: string
	items: Worktree[]
}

/** Default branch prefix groups */
export const DEFAULT_GROUPS: Omit<WorktreeGroup, 'items'>[] = [
	{ id: 'features', name: 'Features', pattern: 'feature/*' },
	{ id: 'bugfixes', name: 'Bug Fixes', pattern: 'bugfix/*' },
	{ id: 'hotfixes', name: 'Hotfixes', pattern: 'hotfix/*' },
	{ id: 'releases', name: 'Releases', pattern: 'release/*' },
]

/**
 * Match a branch name against a glob-like pattern.
 * Supports simple prefix patterns like "feature/*" and exact matches.
 */
export function matchBranchPattern(branch: string, pattern: string): boolean {
	if (pattern === '*') return true
	if (pattern.endsWith('/*')) {
		const prefix = pattern.slice(0, -2)
		return branch.startsWith(prefix + '/')
	}
	return branch === pattern
}

/**
 * Group worktrees by branch prefix patterns.
 * Unmatched worktrees go into an "Other" group.
 */
export function groupWorktrees(
	worktrees: Worktree[],
	customGroups?: Omit<WorktreeGroup, 'items'>[],
): WorktreeGroup[] {
	const allGroups = [...DEFAULT_GROUPS, ...(customGroups ?? [])]
	const assigned = new Set<string>()

	const groups: WorktreeGroup[] = allGroups.map((g) => ({
		...g,
		items: [],
	}))

	// Add "Other" group for unmatched worktrees
	const otherGroup: WorktreeGroup = { id: 'other', name: 'Other', pattern: '*', items: [] }

	// Assign worktrees to groups
	for (const wt of worktrees) {
		let matched = false
		for (const group of groups) {
			if (matchBranchPattern(wt.branch, group.pattern)) {
				group.items.push(wt)
				assigned.add(wt.id)
				matched = true
				break
			}
		}
		if (!matched) {
			otherGroup.items.push(wt)
		}
	}

	// Only include groups that have items
	const result = groups.filter((g) => g.items.length > 0)
	if (otherGroup.items.length > 0) {
		result.push(otherGroup)
	}

	return result
}

/**
 * Sort worktrees by last activity (most recently used first).
 * Falls back to creation date if no activity tracking.
 */
export function sortByActivity(worktrees: Worktree[]): Worktree[] {
	return [...worktrees].sort((a, b) => {
		// Sort by creation date as a proxy for activity
		return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
	})
}