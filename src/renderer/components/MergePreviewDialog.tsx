/**
 * MergePreviewDialog — conflict preview with severity indicators.
 *
 * Shows:
 * - Merge direction (source → target branch)
 * - List of conflicted files with severity (low/medium/high)
 * - Detection mode indicator
 * - Quick actions: resolve, abort
 */

import { AlertTriangle, ArrowUpCircle, FileCode, GitMerge, Loader2, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import type { MergePreviewInfo } from '@/lib/worktree-api'
import { AiPromptDialog } from './AiPromptDialog'
import { ConflictResolutionPanel } from './ConflictResolutionPanel'

interface MergePreviewDialogProps {
  isOpen: boolean
  onClose: () => void
  preview: MergePreviewInfo | null
  loading: boolean
  error: string | null
  onExecuteMerge: () => void
  worktreePath: string
  projectName: string
  sourceBranch: string
}

export function MergePreviewDialog({
  isOpen,
  onClose,
  preview,
  loading,
  error,
  onExecuteMerge,
  worktreePath,
  projectName
}: MergePreviewDialogProps) {
  const [showAiPrompts, setShowAiPrompts] = useState(false)
  const [showConflictPanel, setShowConflictPanel] = useState(false)

  const handleResolveConflicts = useCallback(() => {
    setShowConflictPanel(true)
  }, [])

  const handleAiHelp = useCallback(() => {
    setShowAiPrompts(true)
  }, [])

  if (!isOpen) return null

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="w-[500px] max-w-[90vw] bg-popover border border-border rounded-lg shadow-2xl flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <GitMerge size={14} className="text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Merge Preview</h2>
            </div>
            <button
              onClick={onClose}
              className="h-6 w-6 flex items-center justify-center rounded hover:bg-secondary text-muted-foreground"
            >
              <X size={12} />
            </button>
          </div>

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Detecting conflicts...</span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="px-4 py-3">
              <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-xs">
                <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            </div>
          )}

          {/* Preview content */}
          {preview && !loading && (
            <div className="px-4 py-3 space-y-3">
              {/* Direction + detection mode */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ArrowUpCircle size={14} className="text-primary" />
                  <span className="text-sm font-medium text-foreground">{preview.direction}</span>
                </div>
                <span
                  className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded font-medium',
                    preview.detectionMode === 'accurate'
                      ? 'bg-green-500/10 text-green-500'
                      : 'bg-yellow-500/10 text-yellow-500'
                  )}
                >
                  {preview.detectionMode}
                </span>
              </div>

              {/* Summary */}
              <div className="flex gap-4 text-xs">
                <div>
                  <span className="text-muted-foreground">Changed files: </span>
                  <span className="font-medium text-foreground">{preview.totalChanges}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Conflicts: </span>
                  <span
                    className={cn(
                      'font-medium',
                      preview.conflictFiles.length > 0 ? 'text-destructive' : 'text-green-500'
                    )}
                  >
                    {preview.conflictFiles.length}
                  </span>
                </div>
              </div>

              {/* Conflict files list */}
              {preview.conflictFiles.length > 0 && (
                <div className="space-y-1 max-h-[180px] overflow-auto">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Conflicted Files
                  </p>
                  {preview.conflictFiles.map((file) => (
                    <div
                      key={file.path}
                      className="flex items-center gap-2 px-2 py-1 rounded text-xs bg-destructive/5"
                    >
                      <FileCode size={10} className="text-muted-foreground flex-shrink-0" />
                      <span className="flex-1 truncate text-foreground">{file.path}</span>
                      <span
                        className={cn(
                          'text-[9px] px-1 rounded font-medium',
                          file.severity === 'high'
                            ? 'bg-destructive/10 text-destructive'
                            : file.severity === 'medium'
                              ? 'bg-yellow-500/10 text-yellow-500'
                              : 'bg-green-500/10 text-green-500'
                        )}
                      >
                        {file.severity}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Changed files list (no conflict) */}
              {preview.changedFiles.length > 0 && (
                <div className="space-y-1 max-h-[100px] overflow-auto">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Files that will change
                  </p>
                  {preview.changedFiles.map((file) => (
                    <div
                      key={file}
                      className="flex items-center gap-2 px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      <FileCode size={10} className="flex-shrink-0" />
                      <span className="truncate">{file}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* No conflicts */}
              {preview.conflictFiles.length === 0 && preview.changedFiles.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">
                  No conflicts detected. Ready to merge.
                </p>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-2 border-t border-border">
                {preview.conflictFiles.length > 0 ? (
                  <>
                    <button
                      onClick={handleResolveConflicts}
                      className="flex-1 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                    >
                      Resolve Conflicts
                    </button>
                    <button
                      onClick={handleAiHelp}
                      className="px-3 py-1.5 rounded-md text-xs font-medium bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                    >
                      AI Help
                    </button>
                  </>
                ) : (
                  <button
                    onClick={onExecuteMerge}
                    className="flex-1 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    Execute Merge
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </div>

              {/* Conflict resolution panel */}
              {showConflictPanel && preview.conflictFiles.length > 0 && (
                <div className="pt-2 border-t border-border">
                  <ConflictResolutionPanel
                    conflictFiles={preview.conflictFiles.map((f) => f.path)}
                    sourceBranch={preview.sourceBranch}
                    targetBranch={preview.targetBranch}
                  />
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {!preview && !loading && !error && (
            <div className="text-center py-12">
              <GitMerge size={24} className="mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Select a merge direction to preview conflicts.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* AI Prompt Dialog */}
      <AiPromptDialog
        isOpen={showAiPrompts}
        onClose={() => setShowAiPrompts(false)}
        context={
          preview
            ? {
                sourceBranch: preview.sourceBranch,
                targetBranch: preview.targetBranch,
                conflictFiles: preview.conflictFiles.map((f) => f.path),
                worktreePath,
                projectName
              }
            : undefined
        }
      />
    </>
  )
}
