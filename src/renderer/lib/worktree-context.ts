import { activeWorktreeOf } from '@/lib/active-worktree'
import { worktreeApi } from '@/lib/api'
import { serverAdmitsRemoteWrites } from '@/lib/tauri-runtime'
import { useProjectStore } from '@/stores/project-store'
import { useShellLayoutStore } from '@/stores/shell-layout-store'
import type { Worktree } from '@/types/project'

/**
 * Get the main project root path (ignoring any active worktree).
 *
 * Skills are stored at `{project.path}/.agents/skills/`, which is gitignored
 * (`/.agents`) and excluded from worktree symlinks (`SYMLINK_EXCLUSION_LIST`).
 * A worktree path therefore has no `.agents/skills/`, so skill discovery must
 * always resolve against the main project root — never the worktree CWD.
 */
export function getProjectRootPath(projectId: string): string {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
  return project?.path ?? ''
}

export function getDefaultCwdForProject(projectId: string): string {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
  return project?.path ?? ''
}

/** The Workspace-switcher pick for a project, read from the shell-layout store. */
function pickOf(projectId: string): string | undefined {
  return useShellLayoutStore.getState().worktreePickByProject[projectId]
}

/**
 * Get the active worktree for a project, if any: the worktree the switcher
 * pick resolves to (a pruned or disabled pick resolves as the project folder).
 */
export function getActiveWorktreeForProject(projectId: string): Worktree | undefined {
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
  return activeWorktreeOf(project, pickOf(projectId))
}

/**
 * Ensure symlinks exist for the active worktree of a project.
 * Reads the project's symlinkDirs setting and creates any missing symlinks.
 * Best-effort: logs warnings on failure but does not block terminal spawn.
 */
export async function ensureWorktreeSymlinks(projectId: string): Promise<void> {
  if (!serverAdmitsRemoteWrites()) return
  const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
  if (!project?.path || !project.isGitRepo) return

  const worktree = activeWorktreeOf(project, pickOf(projectId))
  if (!worktree) return

  const symlinkDirs = project.symlinkDirs
  if (!symlinkDirs || symlinkDirs.length === 0) return

  try {
    const result = await worktreeApi.ensureSymlinks(project.path, worktree.path, symlinkDirs)
    if (!result.success) {
      console.warn('[WorktreeSymlinks] Ensure symlinks failed:', result.error)
    }
  } catch (err) {
    console.warn('[WorktreeSymlinks] Ensure symlinks error:', err)
  }
}
