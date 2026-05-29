/**
 * Worktree status polling hook.
 *
 * Polls git status for worktrees using the Tauri worktree_check_dirty command.
 * The active worktree is polled every 2s; other visible worktrees every 10s.
 * Re-renders only on status change, not on every poll.
 *
 * Status cache is shared across hook instances so sidebar items can
 * read health badges without subscribing to polling state.
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
 * Poll a single worktree's dirty status and update the cache.
 */
async function pollWorktree(worktreeId: string, worktreePath: string): Promise<WorktreeHealthStatus | null> {
	try {
		const result = await worktreeApi.checkDirty(worktreePath)
		if (result.success && result.data) {
			const health = mapDirtyToHealth(result.data)
			updateCache(worktreeId, {
				health,
				modified: result.data.modified,
				staged: result.data.staged,
				untracked: result.data.untracked,
				lastChecked: Date.now(),
				lastAccessed: Date.now(),
			})
			return health
		}
	} catch {
		// Polling errors are best-effort
	}
	return null
}

/**
 * Hook to poll worktree status for a project.
 *
 * Polls the active worktree frequently (2s) and other visible
 * worktrees less frequently (10s). Uses shared status cache so
 * sidebar items can read health badges without subscribing.
 *
 * @param projectId - The project to watch
 * @param activePollIntervalMs - Polling interval for active worktree (default: 2000)
 * @param inactivePollIntervalMs - Polling interval for other worktrees (default: 10000)
 */
export function useWorktreeStatus(
	projectId: string,
	activePollIntervalMs = 2000,
	inactivePollIntervalMs = 10000,
) {
	const [currentStatus, setCurrentStatus] = useState<WorktreeStatus | null>(null)
	const [isPolling, setIsPolling] = useState(false)
	const lastHealthRef = useRef<WorktreeHealthStatus | null>(null)
	const activeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
	const inactiveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

	// Subscribe to project state — use stable primitive selectors to avoid re-render loops
	const activeWorktreeId = useProjectStore(
		(state) => state.projects.find((p) => p.id === projectId)?.activeWorktreeId,
	)

	const activeWorktreePath = useProjectStore((state) => {
		const project = state.projects.find((p) => p.id === projectId)
		if (!project?.activeWorktreeId) return null
		return project.worktrees?.find((w) => w.id === project.activeWorktreeId)?.path ?? null
	})

	// Inactive worktree count (primitive — stable for selector equality)
	const inactiveWorktreeCount = useProjectStore((state) => {
		const project = state.projects.find((p) => p.id === projectId)
		if (!project?.worktrees) return 0
		return project.worktrees.filter((w) => w.id !== project.activeWorktreeId).length
	})

	// Ref to track last meaningful status fields to avoid re-renders on lastChecked-only changes
	const lastMeaningfulRef = useRef<{
		health: WorktreeHealthStatus | null
		modified: number
		staged: number
		untracked: number
		conflictCount: number
	} | null>(null)

	// Poll the active worktree
	const pollActive = useCallback(async () => {
		if (!activeWorktreePath || !activeWorktreeId) return

		const health = await pollWorktree(activeWorktreeId, activeWorktreePath)
		if (health !== null) {
			const cached = statusCache.get(activeWorktreeId)
			if (cached) {
				// Only update UI when meaningful fields change (not lastChecked-only changes)
				const last = lastMeaningfulRef.current
				if (
					!last ||
					last.health !== cached.health ||
					last.modified !== cached.modified ||
					last.staged !== cached.staged ||
					last.untracked !== cached.untracked ||
					last.conflictCount !== cached.conflictCount
				) {
					setCurrentStatus(cached)
					lastMeaningfulRef.current = {
						health: cached.health,
						modified: cached.modified,
						staged: cached.staged,
						untracked: cached.untracked,
						conflictCount: cached.conflictCount,
					}
				}
				lastHealthRef.current = health
			}
		}
	}, [activeWorktreePath, activeWorktreeId])

	// Poll inactive worktrees — read store directly to avoid selector instability
	const pollInactive = useCallback(async () => {
		const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
		if (!project?.worktrees) return
		const inactive = project.worktrees.filter((w) => w.id !== project.activeWorktreeId)
		for (const wt of inactive) {
			await pollWorktree(wt.id, wt.path)
		}
	}, [projectId])

	// Start/stop polling based on active worktree
	useEffect(() => {
		if (!activeWorktreeId || !activeWorktreePath) {
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

		// Initial poll — active + inactive
		void pollActive()
		void pollInactive()

		// Active worktree: frequent polling
		activeTimerRef.current = setInterval(() => {
			void pollActive()
		}, activePollIntervalMs)

		// Inactive worktrees: less frequent polling
		inactiveTimerRef.current = setInterval(() => {
			void pollInactive()
		}, inactivePollIntervalMs)

		return () => {
			if (activeTimerRef.current) {
				clearInterval(activeTimerRef.current)
				activeTimerRef.current = null
			}
			if (inactiveTimerRef.current) {
				clearInterval(inactiveTimerRef.current)
				inactiveTimerRef.current = null
			}
			setIsPolling(false)
		}
	}, [activeWorktreeId, activeWorktreePath, activePollIntervalMs, inactivePollIntervalMs, pollActive, pollInactive])

	return {
		status: currentStatus,
		isPolling,
		refreshNow: pollActive,
	}
}