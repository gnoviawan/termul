/**
 * Git API for per-file status queries
 *
 * Provides access to the Rust GitTracker's per-file status parsing
 * via Tauri IPC commands.
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauriContext } from '@/lib/tauri-runtime'

export type GitFileStatus =
	| 'modified'
	| 'added'
	| 'deleted'
	| 'untracked'
	| 'renamed'
	| 'conflicted'

export interface GitFileStatusEntry {
	path: string
	status: GitFileStatus
	isStaged: boolean
}

async function projectGitFileStatuses(
	projectPath: string,
): Promise<GitFileStatusEntry[]> {
	if (!isTauriContext()) return []

	const result = await invoke<{
		success: boolean
		data?: GitFileStatusEntry[]
		error?: string
	}>('project_git_file_statuses', { projectPath })

	if (result.success && result.data) {
		return result.data
	}

	return []
}

export const gitApi = {
	projectGitFileStatuses,
	projectGitDiffFile,
}

async function projectGitDiffFile(
	projectPath: string,
	filePath: string,
): Promise<string> {
	if (!isTauriContext()) return ''

	const result = await invoke<{
		success: boolean
		data?: string
		error?: string
	}>('project_git_diff_file', { projectPath, filePath })

	if (result.success && result.data) {
		return result.data
	}

	return ''
}
