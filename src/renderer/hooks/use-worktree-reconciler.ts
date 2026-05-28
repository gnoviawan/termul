/**
 * Worktree reconciliation hook.
 *
 * Periodically verifies that stored worktree entries still exist on disk
 * by cross-referencing with `git worktree list`. Removes or flags orphaned
 * entries that were deleted outside Termul (e.g. via `rm -rf` or `git worktree remove`).
 *
 * Runs reconciliation on project focus and on a 60-second interval.
 */

import { useEffect, useRef, useCallback } from 'react'
import { worktreeApi } from '@/lib/api'
import { useProjectStore, useProjectActions } from '@/stores/project-store'
import type { Worktree } from '@/types/project'

const RECONCILE_INTERVAL_MS = 60_000

/**
 * Hook that reconciles stored worktree entries against actual git worktrees.
 * Removes entries whose paths no longer exist on disk.
 *
 * @param projectId - The project to reconcile
 */
export function useWorktreeReconciler(projectId: string) {
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
	const { removeWorktree, updateProject } = useProjectActions()

	const reconcile = useCallback(async () => {
		const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
		if (!project?.path || !project.isGitRepo || !project.worktrees?.length) return

		try {
			const result = await worktreeApi.list(project.path)
			if (!result.success || !result.data) return

			// Build set of actual worktree paths from git
			const actualPaths = new Set(result.data.map((w) => w.path))

			// Find stored worktrees that no longer exist in git output
			const orphaned = project.worktrees.filter(
				(wt) => !actualPaths.has(wt.path),
			)

			// Remove orphaned entries from store
			for (const wt of orphaned) {
				removeWorktree(projectId, wt.id)
			}

			// If active worktree was orphaned, reset to root
			const activeId = project.activeWorktreeId
			if (activeId && orphaned.some((w) => w.id === activeId)) {
				updateProject(projectId, { activeWorktreeId: null })
			}

			// Add newly discovered worktrees from git (not already in store)
			const storedPaths = new Set(project.worktrees.map((w) => w.path))
			const discovered = result.data.filter(
				(w) => w.path !== project.path && !storedPaths.has(w.path),
			)

			for (const wt of discovered) {
				const newWorktree: Worktree = {
					id: crypto.randomUUID(),
					name: wt.name,
					branch: wt.branch,
					path: wt.path,
					createdAt: new Date().toISOString(),
				}
				// Push to store — use getState to avoid stale closures
				useProjectStore.getState().addWorktree(projectId, newWorktree)
			}
		} catch {
			// Reconciliation is best-effort
		}
	}, [projectId, removeWorktree, updateProject])

	// Run on mount and on interval
	useEffect(() => {
		// Initial reconciliation
		void reconcile()

		timerRef.current = setInterval(() => {
			void reconcile()
		}, RECONCILE_INTERVAL_MS)

		return () => {
			if (timerRef.current) {
				clearInterval(timerRef.current)
				timerRef.current = null
			}
		}
	}, [reconcile])
}