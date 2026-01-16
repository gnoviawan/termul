/**
 * Merge Preview Dialog Component
 *
 * Main merge preview dialog showing files that will change during merge,
 * grouped by status with summary section and proceed/cancel actions.
 * Source: Story 2.3 - Merge Preview UI (File-level diff, changing files list)
 */

import { memo, useEffect, useCallback } from 'react'
import { X, GitMerge, FileCheck, AlertTriangle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useMergeStore, useMergePreview, useIsLoadingPreview, usePreviewError, useShowConflictsOnly, useMergeActions } from '@/stores/merge-store'
import { Loader2 } from 'lucide-react'

export interface MergePreviewDialogProps {
  isOpen: boolean
  projectId: string
  sourceBranch: string
  targetBranch: string
  onProceed?: () => void
  onCancel: () => void
}

/**
 * File group configuration for status indicators
 */
const FILE_GROUP_CONFIG = {
  added: {
    color: 'text-green-500',
    bgColor: 'bg-green-500/10',
    borderColor: 'border-green-500/20',
    icon: FileCheck,
    label: 'Added'
  },
  modified: {
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/20',
    icon: GitMerge,
    label: 'Modified'
  },
  deleted: {
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/20',
    icon: X,
    label: 'Deleted'
  },
  conflicted: {
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/20',
    icon: AlertTriangle,
    label: 'Conflicted'
  }
} as const

/**
 * MergePreviewDialog - Main merge preview dialog
 *
 * Shows:
 * - Summary section with commit/file counts
 * - File list grouped by status (Added, Modified, Deleted, Conflicted)
 * - Show conflicts only toggle
 * - Footer with Proceed/Cancel buttons
 */
export const MergePreviewDialog = memo(({
  isOpen,
  projectId,
  sourceBranch,
  targetBranch,
  onProceed,
  onCancel
}: MergePreviewDialogProps) => {
  const mergePreview = useMergePreview()
  const isLoadingPreview = useIsLoadingPreview()
  const previewError = usePreviewError()
  const showConflictsOnly = useShowConflictsOnly()
  const { getMergePreview, setShowConflictsOnly, clearPreview } = useMergeActions()

  // Load preview on mount
  useEffect(() => {
    if (isOpen && !mergePreview && !isLoadingPreview) {
      getMergePreview(projectId, sourceBranch, targetBranch)
    }
  }, [isOpen, projectId, sourceBranch, targetBranch, mergePreview, isLoadingPreview, getMergePreview])

  // Clear preview when dialog closes
  useEffect(() => {
    if (!isOpen) {
      clearPreview()
    }
  }, [isOpen, clearPreview])

  // Handle Escape key
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel()
    }
  }, [onCancel])

  // Handle toggle conflicts only
  const handleToggleConflictsOnly = useCallback(() => {
    setShowConflictsOnly(!showConflictsOnly)
  }, [showConflictsOnly, setShowConflictsOnly])

  if (!isOpen) return null

  const hasConflicts = mergePreview?.conflictedFiles && mergePreview.conflictedFiles.length > 0
  const canProceed = mergePreview && !isLoadingPreview && !previewError && !hasConflicts

  // Filter files based on showConflictsOnly setting
  const filteredFiles = mergePreview?.changingFiles.filter(file => {
    if (!showConflictsOnly) return true
    // Check if this file is in conflicted files list
    return mergePreview.conflictedFiles.some(conflicted => conflicted.path === file.path)
  }) ?? []

  // Group files by status
  const groupedFiles = {
    added: filteredFiles.filter(f => f.status === 'added'),
    modified: filteredFiles.filter(f => f.status === 'modified'),
    deleted: filteredFiles.filter(f => f.status === 'deleted'),
    conflicted: mergePreview?.conflictedFiles ?? []
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={onCancel}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl w-full max-w-4xl border border-border overflow-hidden max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            tabIndex={-1}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  Merge Preview
                </h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  {sourceBranch} → {targetBranch}
                </p>
              </div>
              <button
                onClick={onCancel}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {/* Loading State */}
              {isLoadingPreview && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center justify-center py-12"
                >
                  <Loader2 className="w-8 h-8 animate-spin text-blue-500 mb-3" />
                  <p className="text-sm text-muted-foreground">
                    Analyzing merge impact...
                  </p>
                </motion.div>
              )}

              {/* Error State */}
              {previewError && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-4 rounded-lg bg-red-500/10 border border-red-500/20"
                >
                  <p className="text-sm text-red-500">
                    Preview generation failed: {previewError}
                  </p>
                </motion.div>
              )}

              {/* Summary Section */}
              {mergePreview && !isLoadingPreview && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="p-4 rounded-lg bg-secondary/20 border border-border"
                >
                  <h3 className="text-sm font-medium text-foreground mb-2">
                    Summary
                  </h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Commits</p>
                      <p className="text-foreground font-semibold">{mergePreview.commitCount}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Total Changes</p>
                      <p className="text-foreground font-semibold">{mergePreview.changingFiles.length}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Added</p>
                      <p className="text-green-500 font-semibold">{mergePreview.filesAdded}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Modified</p>
                      <p className="text-blue-500 font-semibold">{mergePreview.filesModified}</p>
                    </div>
                  </div>
                  {hasConflicts && (
                    <div className="mt-3 pt-3 border-t border-border">
                      <p className="text-red-500 text-sm font-medium flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4" />
                        {mergePreview.conflictedFiles.length} conflict{mergePreview.conflictedFiles.length !== 1 ? 's' : ''} require resolution
                      </p>
                    </div>
                  )}
                </motion.div>
              )}

              {/* Show Conflicts Only Toggle */}
              {mergePreview && !isLoadingPreview && hasConflicts && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center justify-between p-3 rounded-lg bg-secondary/10 border border-border"
                >
                  <label className="text-sm text-foreground cursor-pointer flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={showConflictsOnly}
                      onChange={handleToggleConflictsOnly}
                      className="w-4 h-4 rounded border-border"
                    />
                    Show conflicts only
                  </label>
                </motion.div>
              )}

              {/* File List */}
              {mergePreview && !isLoadingPreview && (
                <div className="space-y-3">
                  {(['added', 'modified', 'deleted', 'conflicted'] as const).map(status => {
                    const files = groupedFiles[status]
                    if (files.length === 0) return null

                    const config = FILE_GROUP_CONFIG[status]
                    const Icon = config.icon

                    return (
                      <motion.div
                        key={status}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={cn(
                          'border rounded-lg overflow-hidden',
                          config.borderColor
                        )}
                      >
                        <div className={cn(
                          'flex items-center gap-2 px-3 py-2 border-b',
                          config.bgColor
                        )}>
                          <Icon className={cn('w-4 h-4', config.color)} />
                          <span className="text-sm font-medium text-foreground">
                            {config.label} ({files.length})
                          </span>
                        </div>
                        <div className="max-h-[200px] overflow-y-auto">
                          {files.map((file, index) => (
                            <div
                              key={file.path}
                              className={cn(
                                'px-3 py-2 text-xs font-mono border-b border-border last:border-b-0 hover:bg-secondary/30 transition-colors cursor-pointer',
                                index % 2 === 0 && 'bg-secondary/5'
                              )}
                            >
                              {file.path}
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border bg-secondary/20 flex-shrink-0">
              <button
                onClick={onCancel}
                disabled={isLoadingPreview}
                className="px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>

              {canProceed && (
                <button
                  onClick={onProceed}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-green-500 text-white hover:bg-green-600 transition-colors"
                >
                  Proceed to Merge
                </button>
              )}

              {hasConflicts && !isLoadingPreview && (
                <div className="text-sm text-red-500">
                  Resolve conflicts before merging
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
})

MergePreviewDialog.displayName = 'MergePreviewDialog'
