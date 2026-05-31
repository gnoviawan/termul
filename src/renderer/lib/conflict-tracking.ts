/**
 * Conflict resolution tracking types and utilities.
 *
 * Tracks per-file resolution status and overall progress
 * for merge conflict resolution workflows.
 */

export type FileResolutionStatus = 'unresolved' | 'resolving' | 'resolved'

export interface ConflictFileStatus {
	filePath: string
	status: FileResolutionStatus
	/** Strategy used for resolution */
	resolutionStrategy?: 'manual' | 'ai-assisted' | 'ours' | 'theirs'
	/** Timestamp of resolution */
	resolvedAt?: number
}

export interface ConflictResolutionState {
	/** Map of file path to resolution status */
	files: Map<string, ConflictFileStatus>
	/** Total conflict count */
	totalConflicts: number
	/** Number resolved */
	resolvedCount: number
	/** Overall progress (0-1) */
	progress: number
}

/**
 * Create initial conflict resolution state from a list of conflicting files.
 */
export function createConflictState(conflictFiles: string[]): ConflictResolutionState {
	const files = new Map<string, ConflictFileStatus>()
	for (const filePath of conflictFiles) {
		files.set(filePath, {
			filePath,
			status: 'unresolved',
		})
	}
	return {
		files,
		totalConflicts: conflictFiles.length,
		resolvedCount: 0,
		progress: 0,
	}
}

/**
 * Update a file's resolution status.
 */
export function updateFileStatus(
	state: ConflictResolutionState,
	filePath: string,
	status: FileResolutionStatus,
	strategy?: ConflictFileStatus['resolutionStrategy'],
): ConflictResolutionState {
	const files = new Map(state.files)
	const existing = files.get(filePath)

	files.set(filePath, {
		filePath,
		status,
		resolutionStrategy: strategy ?? existing?.resolutionStrategy,
		resolvedAt: status === 'resolved' ? Date.now() : undefined,
	})

	const resolvedCount = Array.from(files.values()).filter(
		(f) => f.status === 'resolved',
	).length

	return {
		files,
		totalConflicts: state.totalConflicts,
		resolvedCount,
		progress: state.totalConflicts > 0 ? resolvedCount / state.totalConflicts : 0,
	}
}

/**
 * Get unresolved files from the conflict state.
 */
export function getUnresolvedFiles(state: ConflictResolutionState): ConflictFileStatus[] {
	return Array.from(state.files.values()).filter((f) => f.status === 'unresolved')
}

/**
 * Generate an AI prompt for resolving a specific file's conflicts.
 */
export function generateConflictResolutionPrompt(
	filePath: string,
	sourceBranch: string,
	targetBranch: string,
): string {
	return `Resolve merge conflicts in ${filePath} between branches ${sourceBranch} and ${targetBranch}. Preserve the intent of both changes where possible. When conflicts are truly incompatible, prefer the ${targetBranch} version for shared configuration and the ${sourceBranch} version for feature-specific logic.`
}