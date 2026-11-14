import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { logFrontendError } from '@/lib/log-api'
import { randomUUID } from '@/lib/uuid'
import { worktreeApi } from '@/lib/worktree-api'
import { reconcileProjectWorktrees, worktreeKey } from '@/lib/worktree-reconciler'
import { useProjectStore } from '@/stores/project-store'
import { useShellLayoutStore } from '@/stores/shell-layout-store'
import { useWorktreeProgressStore } from '@/stores/worktree-progress-store'
import type { Project } from '@/types/project'

const LOG_SOURCE = 'shell-workspace-switcher'

/** Windows `MAX_PATH` is 260; leave room for the files inside the worktree. */
const MAX_TARGET_PATH = 240

export type CreateWorktreeStatus = 'created' | 'refused' | 'failed'

export interface UseCreateWorktree {
  create: (name: string) => Promise<CreateWorktreeStatus>
  creating: boolean
  /** Inline refusal line (exists / too long / locked); null when none. */
  error: string | null
  clearError: () => void
}

type CreateProject = Pick<Project, 'id' | 'path' | 'worktrees' | 'symlinkDirs'>

function refusalFor(project: CreateProject, name: string, locked: boolean): string | null {
  if (locked) return 'Another worktree operation is in progress'
  const exists = (project.worktrees ?? []).some((w) => w.branch === name || w.name === name)
  if (exists) return `A worktree for branch "${name}" already exists`
  if (`${project.path ?? ''}/.termul/worktrees/${name}/`.length > MAX_TARGET_PATH) {
    return 'Path too long'
  }
  return null
}

function reportFailure(reason: string): void {
  // The error text only: never the branch name or anything the user typed.
  void logFrontendError({
    level: 'warn',
    source: LOG_SOURCE,
    message: `[workspace-switcher] create worktree failed: ${reason}`
  })
  toast.error('Failed to create worktree', { description: reason })
}

/**
 * Create a worktree (and branch) named `name` from the Rail worktree switcher: the
 * minimal path of `NewWorktreeModal` (no `.worktree-include` copy, no collision
 * retry, no terminal). Success registers it through the reconciler, links the
 * project's symlink dirs and picks it, as the switcher's third pick writer.
 */
export function useCreateWorktree(project: CreateProject): UseCreateWorktree {
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clearError = useCallback(() => setError(null), [])

  const create = useCallback(
    async (name: string): Promise<CreateWorktreeStatus> => {
      const projectStore = useProjectStore.getState()
      const refusal = refusalFor(project, name, projectStore.isWorktreeOperationLocked)
      if (refusal || !project.path) {
        setError(refusal ?? 'Project has no folder')
        return 'refused'
      }

      setError(null)
      setCreating(true)
      projectStore.setWorktreeOperationLock(true)
      const progress = useWorktreeProgressStore.getState()
      const progressId = randomUUID()
      try {
        progress.begin(progressId, name)
        const result = await worktreeApi.create({
          projectPath: project.path,
          name,
          branch: name,
          isNewBranch: true,
          progressId,
          onProgress: progress.handleEvent
        })
        if (!result.success || !result.data) {
          const reason = !result.success ? result.error : 'Unknown error'
          progress.finish(progressId, reason)
          reportFailure(reason)
          return 'failed'
        }
        progress.finish(progressId)
        const created = result.data

        await reconcileProjectWorktrees(project.id)

        const symlinkDirs = useProjectStore
          .getState()
          .projects.find((p) => p.id === project.id)?.symlinkDirs
        if (symlinkDirs && symlinkDirs.length > 0) {
          try {
            await worktreeApi.createSymlinks(project.path, created.path, symlinkDirs)
          } catch {
            // Non-blocking, as in the modal: the worktree itself exists.
          }
        }

        const reconciled = useProjectStore.getState().projects.find((p) => p.id === project.id)
        const key = worktreeKey(created.path)
        if (reconciled?.worktrees?.some((w) => worktreeKey(w.path) === key)) {
          useShellLayoutStore.getState().setWorktreePick(project.id, created.path)
        } else {
          void logFrontendError({
            level: 'warn',
            source: LOG_SOURCE,
            message:
              '[workspace-switcher] created worktree is not listed after reconcile; not picked'
          })
        }
        toast.success('Worktree created')
        return 'created'
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        progress.finish(progressId, reason)
        reportFailure(reason)
        return 'failed'
      } finally {
        setCreating(false)
        progress.clear(progressId)
        useProjectStore.getState().setWorktreeOperationLock(false)
      }
    },
    [project]
  )

  return { create, creating, error, clearError }
}
