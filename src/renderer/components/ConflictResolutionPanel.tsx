/**
 * Conflict Resolution Panel — per-file resolution tracking with progress.
 *
 * Displays:
 * - Per-file resolution state (unresolved / resolving / resolved)
 * - Overall progress bar
 * - Summary view of remaining conflicts
 */

import { AlertTriangle, CheckCircle2, Circle, FileCode, Loader2 } from 'lucide-react'
import { useCallback, useState } from 'react'
import {
  type ConflictResolutionState,
  createConflictState,
  type FileResolutionStatus,
  getUnresolvedFiles,
  updateFileStatus
} from '@/lib/conflict-tracking'
import { cn } from '@/lib/utils'

interface ConflictResolutionPanelProps {
  /** List of conflicted file paths */
  conflictFiles: string[]
  /** Source branch name for display */
  sourceBranch: string
  /** Target branch name for display */
  targetBranch: string
  /** Called when all conflicts are resolved */
  onAllResolved?: () => void
}

export function ConflictResolutionPanel({
  conflictFiles,
  sourceBranch,
  targetBranch,
  onAllResolved
}: ConflictResolutionPanelProps) {
  const [state, setState] = useState<ConflictResolutionState>(() =>
    createConflictState(conflictFiles)
  )

  const handleFileStatusChange = useCallback(
    (filePath: string, status: FileResolutionStatus) => {
      setState((prev) => {
        const next = updateFileStatus(prev, filePath, status)
        if (next.progress === 1 && onAllResolved) {
          // Defer callback to avoid setState during render
          setTimeout(onAllResolved, 0)
        }
        return next
      })
    },
    [onAllResolved]
  )

  const unresolved = getUnresolvedFiles(state)
  const progressPercent = Math.round(state.progress * 100)

  return (
    <div className="space-y-3">
      {/* Header summary */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AlertTriangle size={14} className="text-yellow-500" />
          <span>
            {sourceBranch} → {targetBranch}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {state.resolvedCount}/{state.totalConflicts} resolved
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500 ease-out',
            progressPercent === 100 ? 'bg-green-500' : 'bg-primary'
          )}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Per-file status list */}
      <div className="space-y-1 max-h-[200px] overflow-auto">
        {Array.from(state.files.values()).map((file) => {
          const StatusIcon =
            file.status === 'resolved'
              ? CheckCircle2
              : file.status === 'resolving'
                ? Loader2
                : Circle

          return (
            <div
              key={file.filePath}
              className={cn(
                'flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors',
                file.status === 'resolved'
                  ? 'text-green-500/80'
                  : file.status === 'resolving'
                    ? 'text-blue-500/80'
                    : 'text-muted-foreground hover:bg-secondary/50'
              )}
            >
              <StatusIcon
                size={12}
                className={cn('flex-shrink-0', file.status === 'resolving' && 'animate-spin')}
              />
              <FileCode size={10} className="flex-shrink-0 opacity-60" />
              <span className="flex-1 truncate">{file.filePath}</span>
              <div className="flex gap-1">
                {file.status !== 'resolved' && (
                  <>
                    <button
                      onClick={() => handleFileStatusChange(file.filePath, 'resolved')}
                      className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-green-500/10 text-green-500 hover:bg-green-500/20 transition-colors"
                      title="Mark as resolved"
                    >
                      ✓
                    </button>
                    {file.status !== 'resolving' && (
                      <button
                        onClick={() => handleFileStatusChange(file.filePath, 'resolving')}
                        className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 transition-colors"
                        title="Mark as resolving"
                      >
                        ↻
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Empty state */}
      {unresolved.length === 0 && state.totalConflicts > 0 && (
        <div className="text-center py-4">
          <CheckCircle2 size={24} className="mx-auto mb-2 text-green-500" />
          <p className="text-xs font-medium text-foreground">All conflicts resolved!</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Ready to complete the merge.</p>
        </div>
      )}
    </div>
  )
}
