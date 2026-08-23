import { useEffect, useRef } from 'react'
import { gitApi } from '@/lib/api'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'

/**
 * Auto-detect the active project's current git branch and seed
 * `project.gitBranch` with the real HEAD branch — instead of showing a stale
 * hardcoded 'main' in the status bar before any terminal has reported a branch
 * (or when the project has no active terminal at all).
 *
 * Runs on active-project change. Skips projects that are not git repos or have
 * no path. Transport-neutral: `gitApi.getCommitContext` branches on
 * `isTauriContext()` (desktop invoke / same-origin server HTTP), so the
 * status bar reflects the real branch on both desktop and the termul-server
 * web/remote client.
 *
 * Best-effort: a fetch failure leaves the existing (or absent) value alone;
 * the manual GitBranchPicker switch path still updates `gitBranch`, and the
 * per-terminal git branch events (useGitBranch) take precedence in the status
 * bar once a terminal reports its branch.
 */
export function useProjectGitBranch(): void {
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const updateProject = useProjectStore((state) => state.updateProject)
  // Track the in-flight project id so a fast switch does not let a slow
  // earlier fetch stampede over the newer project's branch.
  const inflightRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeProjectId) return

    const project: Project | undefined = useProjectStore
      .getState()
      .projects.find((p) => p.id === activeProjectId)
    // No path or known non-git → nothing to detect. `isGitRepo` is undefined
    // for fresh projects (not yet reconciled) — still attempt detection so a
    // repo is detected on first activation rather than only after the worktree
    // reconciler flips the flag.
    if (!project?.path || project.isGitRepo === false) return

    inflightRef.current = activeProjectId
    const path = project.path
    let cancelled = false

    gitApi
      .getCommitContext(path)
      .then((context) => {
        if (cancelled || inflightRef.current !== activeProjectId) return
        // branch is null on a detached HEAD / no-branch state — leave the
        // project value untouched in that case (the status bar renders
        // 'detached' from the null terminal branch anyway).
        if (context.branch) {
          updateProject(activeProjectId, { gitBranch: context.branch })
        }
      })
      .catch(() => {
        // Not a git repo, git missing, or fetch failed — leave the existing
        // value alone. The worktree reconciler handles isGitRepo separately.
      })
      .finally(() => {
        if (inflightRef.current === activeProjectId) inflightRef.current = null
      })

    return () => {
      cancelled = true
    }
  }, [activeProjectId, updateProject])
}
