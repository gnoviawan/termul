/**
 * Worktree context utilities for terminal and file explorer integration.
 *
 * Resolves the active worktree's CWD for new terminal spawning
 * and file explorer root switching.
 */

import { useProjectStore } from '@/stores/project-store'
import type { Project, Worktree } from '@/types/project'

/**
 * Get the default CWD for a project, resolving from the active worktree if set.
 * Falls back to the project root path if no active worktree or worktree not found.
 */
export function getDefaultCwdForProject(projectId: string): string {
	const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
	if (!project?.path) return ''

	if (project.activeWorktreeId) {
		const worktree = project.worktrees?.find((w) => w.id === project.activeWorktreeId)
		if (worktree) return worktree.path
	}

	return project.path
}

/**
 * Get the active worktree for a project, if any.
 */
export function getActiveWorktreeForProject(projectId: string): Worktree | undefined {
	const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
	if (!project?.activeWorktreeId) return undefined
	return project.worktrees?.find((w) => w.id === project.activeWorktreeId)
}

/**
 * Get a display-friendly context string for a terminal running in a worktree.
 * Format: "project-name / worktree-name" or "project-name / Root"
 */
export function getWorktreeContextLabel(project: Project): string {
	if (!project.activeWorktreeId) {
		return `${project.name} / Root`
	}
	const worktree = project.worktrees?.find((w) => w.id === project.activeWorktreeId)
	if (worktree) {
		return `${project.name} / ${worktree.name}`
	}
	return `${project.name} / Root`
}

/**
 * Get the worktree name for display in terminal tabs.
 * Returns the worktree branch name, or null if on project root.
 */
export function getWorktreeTabContext(projectId: string): string | null {
	const worktree = getActiveWorktreeForProject(projectId)
	return worktree?.name ?? null
}

/**
 * Check if a path still exists on disk by attempting to verify it.
 * This is a synchronous check that can be used to detect stale worktree paths.
 * Note: Actual file system checks should be done async via the Rust backend.
 */
export function isWorktreePathStale(worktreePath: string): boolean {
	// We can't check the filesystem synchronously from the renderer.
	// This is a placeholder that returns false; actual staleness detection
	// should be done in the reconciliation hook (useWorktreeReconciler).
	return false
}