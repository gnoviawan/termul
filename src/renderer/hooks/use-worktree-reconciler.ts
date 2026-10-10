/**
 * Worktree reconciliation hook.
 *
 * Thin trigger over the single-flight reconciler (`lib/worktree-reconciler.ts`,
 * the only writer of `project.worktrees`): runs on mount and on a 60-second
 * interval, on desktop and web alike. Desktop additionally ensures the
 * configured symlink dirs exist in each stored worktree.
 */

import { useCallback, useEffect, useRef } from 'react'
import { isTauriContext } from '@/lib/tauri-runtime'
import { worktreeApi } from '@/lib/worktree-api'
import { reconcileProjectWorktrees } from '@/lib/worktree-reconciler'
import { useProjectStore } from '@/stores/project-store'

const RECONCILE_INTERVAL_MS = 60_000

/**
 * Hook that keeps the stored worktrees of a project in sync with git.
 *
 * @param projectId - The project to reconcile
 */
export function useWorktreeReconciler(projectId: string) {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const reconcile = useCallback(async () => {
    try {
      await reconcileProjectWorktrees(projectId)

      // Symlink ensure is desktop-only. Read the post-reconcile store state.
      if (!isTauriContext()) return
      const project = useProjectStore.getState().projects.find((p) => p.id === projectId)
      const symlinkDirs = project?.symlinkDirs
      if (!project?.isGitRepo || !project.path || !symlinkDirs || symlinkDirs.length === 0) return
      for (const wt of project.worktrees ?? []) {
        try {
          await worktreeApi.ensureSymlinks(project.path, wt.path, symlinkDirs)
        } catch {
          // Symlink ensure is best-effort
        }
      }
    } catch {
      // Reconciliation is best-effort
    }
  }, [projectId])

  // Run on mount and on interval
  useEffect(() => {
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
