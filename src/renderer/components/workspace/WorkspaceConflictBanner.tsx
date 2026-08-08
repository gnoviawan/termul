/**
 * Workspace conflict banner (CAP-5 / Story 6).
 *
 * Surfaces a `WriteOutcome.Conflict` as a recoverable UI with three actions:
 * Reload from host / Overwrite with local / Dismiss. Conflict is a success-
 * body variant (not an error), so this is a banner, not an error toast.
 * Reads `pendingConflict` from the sync store; auto-dismisses when the
 * conflict clears (after any of the three resolution paths runs).
 *
 * P1: the banner is only shown for the *active* project. If a conflict was
 * surfaced for project A and the user switched to project B, the banner is
 * hidden until they switch back — clicking "Reload from host" while viewing
 * B would otherwise call `loadProjectWorkspace` for A and clobber B's tree.
 */

import { useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { resolveManifestConflict } from '@/hooks/use-workspace-manifest-sync'
import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceManifestSyncStore } from '@/stores/workspace-manifest-sync-store'

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

export function WorkspaceConflictBanner(): null | React.ReactElement {
  const conflict = useWorkspaceManifestSyncStore((state) => state.pendingConflict)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)

  const handleReload = useCallback(async () => {
    if (!conflict) return
    await resolveManifestConflict(conflict.projectId, 'reload')
  }, [conflict])

  const handleOverwrite = useCallback(async () => {
    if (!conflict) return
    await resolveManifestConflict(conflict.projectId, 'overwrite')
  }, [conflict])

  const handleDismiss = useCallback(async () => {
    if (!conflict) return
    await resolveManifestConflict(conflict.projectId, 'dismiss')
  }, [conflict])

  // P1: only show the banner for the active project. A conflict for a
  // background project is hidden until the user switches back to it.
  if (!conflict || conflict.projectId !== activeProjectId) return null

  const identitySuffix = conflict.currentUpdateIdentity
    ? ` by ${conflict.currentUpdateIdentity}`
    : ''

  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col gap-2 border-b border-amber-500/50 bg-amber-500/10 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-amber-600 dark:text-amber-400">
          Workspace changed elsewhere
        </span>
        <span className="text-xs text-muted-foreground">
          Another client saved this workspace at revision {conflict.currentRevision}
          {conflict.currentUpdatedAt ? ` (${formatTimestamp(conflict.currentUpdatedAt)})` : ''}
          {identitySuffix}. Choose how to proceed.
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button type="button" variant="default" size="xs" onClick={handleReload}>
          Reload from host
        </Button>
        <Button type="button" variant="secondary" size="xs" onClick={handleOverwrite}>
          Overwrite with local
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={handleDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  )
}
