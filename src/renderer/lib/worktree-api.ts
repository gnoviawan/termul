import { invoke } from '@tauri-apps/api/core'
import type {
	IpcResult,
	WorktreeInfo,
	BranchInfo,
	DirtyStatus,
	RemoveResult,
	GitignoreDir,
	SymlinkResult,
} from '@shared/types/ipc.types'

export const worktreeApi = {
	/**
	 * List all worktrees for a git repo at the given path.
	 * Filters out bare worktrees and detached-HEAD worktrees.
	 */
	list: (projectPath: string): Promise<IpcResult<WorktreeInfo[]>> =>
		invoke('worktree_list', { projectPath }),

	/**
	 * Create a new worktree.
	 * If isNewBranch is true, creates a new branch from the startRef (or HEAD).
	 * If branch exists, checks it out in the new worktree.
	 * targetPath defaults to `<project-path>/.termul/worktrees/<name>/` when not provided.
	 */
	create: (params: {
		projectPath: string
		name: string
		branch: string
		isNewBranch: boolean
		startRef?: string
		targetPath?: string
	}): Promise<IpcResult<WorktreeInfo>> =>
		invoke('worktree_create', params),

	/**
	 * Remove a worktree. Uses --force if force=true.
	 * Runs `git worktree prune` after removal.
	 */
	remove: (worktreePath: string, force: boolean): Promise<IpcResult<void>> =>
		invoke('worktree_remove', { worktreePath, force }),

	/**
	 * List local and remote branches for a git repo.
	 */
	branches: (projectPath: string): Promise<IpcResult<BranchInfo[]>> =>
		invoke('worktree_branches', { projectPath }),

	/**
	 * Check dirty status for a worktree checkout.
	 * Returns summary of uncommitted changes.
	 */
	checkDirty: (worktreePath: string): Promise<IpcResult<DirtyStatus>> =>
		invoke('worktree_check_dirty', { worktreePath }),

	/**
	 * Remove all Termul-managed worktrees for a project.
	 * Used during project cascade delete. Reports per-worktree results.
	 */
	removeAllManaged: (
		projectPath: string,
		worktreesJson: string,
	): Promise<IpcResult<RemoveResult[]>> =>
		invoke('worktree_remove_all_managed', { projectPath, worktreesJson }),

	/**
	 * Parse .gitignore and return directory entries that could be symlinked.
	 * Each entry includes whether the directory exists in the project root.
	 */
	parseGitignore: (projectPath: string): Promise<IpcResult<GitignoreDir[]>> =>
		invoke('worktree_parse_gitignore', { projectPath }),

	/**
	 * Create symlinks from project root directories into a worktree.
	 * symlinkDirs is a JSON array of directory names to symlink.
	 */
	createSymlinks: (
		projectPath: string,
		worktreePath: string,
		symlinkDirs: string[],
	): Promise<IpcResult<SymlinkResult[]>> =>
		invoke('worktree_create_symlinks', {
			projectPath,
			worktreePath,
			symlinkDirs: JSON.stringify(symlinkDirs),
		}),

	/**
	 * Ensure symlinks exist for all directories in symlinkDirs.
	 * Creates any missing symlinks. Does not remove or overwrite existing ones.
	 */
	ensureSymlinks: (
		projectPath: string,
		worktreePath: string,
		symlinkDirs: string[],
	): Promise<IpcResult<SymlinkResult[]>> =>
		invoke('worktree_ensure_symlinks', {
			projectPath,
			worktreePath,
			symlinkDirs: JSON.stringify(symlinkDirs),
		}),
}
