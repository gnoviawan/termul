/**
 * Project search and filter utilities.
 *
 * Provides name/path/branch search for managing large project collections
 * in the sidebar. Mirrors the worktree-filter convention.
 */

import type { Project } from '@/types/project'

export interface ProjectFilterOptions {
	/** Search query matched against name, path, and git branch */
	searchQuery?: string
}

/**
 * Filter projects based on a search query.
 * Matches (case-insensitive) against project name, path, and git branch.
 * Returns the input unchanged when the query is empty/whitespace.
 */
export function filterProjects(
	projects: Project[],
	options: ProjectFilterOptions,
): Project[] {
	const query = options.searchQuery?.trim().toLowerCase()
	if (!query) return projects

	return projects.filter((p) => {
		if (p.name.toLowerCase().includes(query)) return true
		if (p.path?.toLowerCase().includes(query)) return true
		if (p.gitBranch?.toLowerCase().includes(query)) return true
		return false
	})
}

/**
 * Threshold at which the project search UI becomes worthwhile.
 * Below this, the list is short enough that a search box is just clutter.
 */
export const PROJECT_SEARCH_THRESHOLD = 8

/**
 * Check if the project search UI should be shown.
 */
export function shouldShowProjectSearch(projectCount: number): boolean {
	return projectCount >= PROJECT_SEARCH_THRESHOLD
}
