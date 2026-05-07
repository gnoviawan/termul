/**
 * Git file status store
 *
 * Maps absolute file paths to their git status for the file explorer.
 * Refreshes on a timer or on demand when the project changes.
 */

import { create } from 'zustand'
import { gitApi, type GitFileStatus, type GitFileStatusEntry } from '@/lib/tauri-git-api'

interface GitFileStatusState {
	/** Absolute file path → git status */
	statusMap: Map<string, GitFileStatusEntry>
	/** Whether the store has been hydrated at least once */
	isLoaded: boolean
	/** Set the status map (called after fetch) */
	setStatuses: (entries: GitFileStatusEntry[]) => void
	/** Get the status for a single file */
	getFileStatus: (filePath: string) => GitFileStatusEntry | undefined
}

export const useGitFileStatusStore = create<GitFileStatusState>((set, get) => ({
	statusMap: new Map(),
	isLoaded: false,

	setStatuses: (entries) => {
		const map = new Map<string, GitFileStatusEntry>()
		for (const entry of entries) {
			map.set(entry.path, entry)
		}
		set({ statusMap: map, isLoaded: true })
	},

	getFileStatus: (filePath) => get().statusMap.get(filePath),
}))

/**
 * Fetch git file statuses for a project root and update the store.
 * Returns a cleanup function to stop the polling timer.
 */
export function startGitFileStatusPolling(projectPath: string): () => void {
	let disposed = false
	let timer: ReturnType<typeof setTimeout> | null = null

	const poll = async (): Promise<void> => {
		if (disposed) return
		try {
			const entries = await gitApi.projectGitFileStatuses(projectPath)
			if (!disposed) {
				useGitFileStatusStore.getState().setStatuses(entries)
			}
		} catch {
			// Silently ignore — git might not be available
		}
		if (!disposed) {
			timer = setTimeout(poll, 5000)
		}
	}

	// Initial fetch + start polling
	void poll()

	return () => {
		disposed = true
		if (timer) clearTimeout(timer)
	}
}
