/**
 * Worktree status polling hook.
 *
 * Efficiently polls the active worktree's git status using the
 * Tauri worktree_check_dirty command. Only polls the active worktree
 * by default, with 2-second debounce intervals.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { worktreeApi } from '@/lib/api'
import { useProjectStore } from '@/stores/project-store'
import type { WorktreeStatus, WorktreeHealthStatus } from '@/types/worktree-status'
import type { DirtyStatus } from '@shared/types/ipc.types'

// Status cache shared across hook instances
const statusCache = new Map<string, WorktreeStatus>()

/** Get a snapshot of the current status cache */
export function getStatusCache(): Map<string, WorktreeStatus> {
	return new Map(statusCache)
}

/** Get status for a specific worktree from the cache */
export function getWorktreeStatusFromCache(worktreeId: string): WorktreeStatus | undefined {
	return statusCache.get(worktreeId)
}

/**
 * Determine health status from DirtyStatus.
 * Maps the IPC dirty status to the simplified health enum.
 */
function mapDirtyToHealth(dirty: DirtyStatus): WorktreeHealthStatus {
	if (dirty.modified > 0 || dirty.staged > 0 || dirty.untracked > 0) {
		return 'dirty'
	}
	return 'clean'
}

/**
 * Update the status cache with new status data.
 */
function updateCache(worktreeId: string, status: Partial<WorktreeStatus>): void {
	const existing = statusCache.get(worktreeId)
	const updated: WorktreeStatus = {
		worktreeId,
		health: status.health ?? existing?.health ?? 'clean',
		modified: status.modified ?? existing?.modified ?? 0,
		staged: status.staged ?? existing?.staged ?? 0,
		untracked: status.untracked ?? existing?.untracked ?? 0,
		conflictCount: status.conflictCount ?? existing?.conflictCount ?? 0,
		lastChecked: status.lastChecked ?? Date.now(),
		lastAccessed: status.lastAccessed ?? existing?.lastAccessed ?? null,
		ciStatus: status.ciStatus ?? existing?.ciStatus ?? 'unknown',
	}
	statusCache.set(worktreeId, updated)
}

/**
 * Hook to poll the active worktree's status.
 *
 * Only polls the currently active worktree for efficiency.
 * Debounced to 2-second intervals.
 * Re-renders only on status change, not on every poll.
 *
 * @param projectId - The project to watch for active worktree
 * @param pollIntervalMs - Polling interval in ms (default: 2000)
 */
export function useWorktreeStatus(projectId: string, pollIntervalMs = 2000) {
	const [currentStatus, setCurrentStatus] = useState<WorktreeStatus | null>(null)
	const [isPolling, setIsPolling] = useState(false)
	const lastHealthRef = useRef<WorktreeHealthStatus | null>(null)
	const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

	// Get active worktree ID from store
	const activeWorktreeId = useProjectStore(
		(state) => state.projects.find((p) => p.id === projectId)?.activeWorktreeId,
	)

	// Get worktree path from store
	const worktreePath = useProjectStore((state) => {
		const project = state.projects.find((p) => p.id === projectId)
		if (!project?.activeWorktreeId) return null
		return project.worktrees?.find((w) => w.id === project.activeWorktreeId)?.path ?? null
	})

	const pollStatus = useCallback(async () => {
		if (!worktreePath || !activeWorktreeId) return

		try {
			const result = await worktreeApi.checkDirty(worktreePath)
			if (result.success && result.data) {
				const health = mapDirtyToHealth(result.data)

				// Only update state if health status changed (prevents unnecessary re-renders)
				if (health !== lastHealthRef.current) {
					lastHealthRef.current = health
					const newStatus: WorktreeStatus = {
						worktreeId: activeWorktreeId,
						health,
						modified: result.data.modified,
						staged: result.data.staged,
						untracked: result.data.untracked,
						conflictCount: 0,
						lastChecked: Date.now(),
						lastAccessed: Date.now(),
						ciStatus: 'unknown',
					}
					updateCache(activeWorktreeId, newStatus)
					setCurrentStatus(newStatus)
				} else {
					// Update cache even if status hasn't changed (refresh timestamp)
					updateCache(activeWorktreeId, {
						modified: result.data.modified,
						staged: result.data.staged,
						untracked: result.data.untracked,
						lastChecked: Date.now(),
					})
				}
			}
		} catch {
			// Polling errors are best-effort
		}
	}, [worktreePath, activeWorktreeId])

	// Start/stop polling based on active worktree
	useEffect(() => {
		if (!activeWorktreeId || !worktreePath) {
			setCurrentStatus(null)
			setIsPolling(false)
			lastHealthRef.current = null
			return
		}

		// Load cached status immediately if available
		const cached = statusCache.get(activeWorktreeId)
		if (cached) {
			setCurrentStatus(cached)
			lastHealthRef.current = cached.health
		}

		setIsPolling(true)

		// Initial poll
		void pollStatus()

		// Set up interval with debounce
		pollTimerRef.current = setInterval(() => {
			void pollStatus()
		}, pollIntervalMs)

		return () => {
			if (pollTimerRef.current) {
				clearInterval(pollTimerRef.current)
				pollTimerRef.current = null
			}
			setIsPolling(false)
		}
	}, [activeWorktreeId, worktreePath, pollIntervalMs, pollStatus])

	return {
		status: currentStatus,
		isPolling,
		refreshNow: pollStatus,
	}
}