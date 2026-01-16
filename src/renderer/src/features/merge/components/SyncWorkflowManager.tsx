/**
 * Sync Workflow Manager Component
 *
 * State machine container for sync workflow (main → feature-branch).
 * Reverse of MergeWorkflowManager - syncs main changes INTO worktree branch.
 * Source: Story 2.5 - Merge Workflow: Sync Upstream (Main INTO worktree)
 */

import { memo, useEffect, useCallback } from 'react'
import { X, Loader2, CheckCircle2, AlertCircle, ChevronLeft, ChevronRight, GitPullRequest } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useMergeStore, useSourceBranch, useTargetBranch, useIsMerging, useMergeError, useMergeResult, useDetectionResult, useMergePreview, useMergeActions } from '@/stores/merge-store'
import { SyncConfirmationStep } from './SyncConfirmationStep'
import { MergeDialog } from './MergeDialog'
import { MergePreviewDialog } from './MergePreviewDialog'
import { MergeValidationStep } from './MergeValidationStep'
import type { WorkflowState } from '@/stores/merge-store'

export interface SyncWorkflowManagerProps {
  isOpen: boolean
  worktreeId: string
  featureBranch: string
  projectId: string
  onComplete?: () => void
  onCancel: () => void
}

/**
 * Sync workflow step configuration
 */
const SYNC_WORKFLOW_STEPS = [
  { id: 'confirm' as WorkflowState, label: 'Confirm Sync', icon: '🔄' },
  { id: 'detect-conflicts' as WorkflowState, label: 'Detect Conflicts', icon: '🔍' },
  { id: 'preview' as WorkflowState, label: 'Preview', icon: '👁️' },
  { id: 'validate' as WorkflowState, label: 'Validate', icon: '✓' },
  { id: 'execute' as WorkflowState, label: 'Execute', icon: '⚡' },
  { id: 'complete' as WorkflowState, label: 'Complete', icon: '✅' }
] as const

/**
 * SyncWorkflowManager - Sync workflow container (main → feature-branch)
 *
 * Reverse of MergeWorkflowManager:
 * - Source: main/master
 * - Target: feature branch (worktree)
 * - Workflow: confirm → detect-conflicts → preview → validate → execute → complete
 */
export const SyncWorkflowManager = memo(({
  isOpen,
  worktreeId,
  featureBranch,
  projectId,
  onComplete,
  onCancel
}: SyncWorkflowManagerProps) => {
  const sourceBranch = useSourceBranch()
  const targetBranch = useTargetBranch()
  const isMerging = useIsMerging()
  const mergeError = useMergeError()
  const mergeResult = useMergeResult()
  const detectionResult = useDetectionResult()
  const mergePreview = useMergePreview()

  const {
    setBranches,
    setWorktreeContext,
    detectConflicts,
    getMergePreview,
    executeMerge,
    clearError
  } = useMergeActions()

  // Initialize workflow on mount - set reversed branches (main → feature)
  useEffect(() => {
    if (isOpen) {
      setWorktreeContext(worktreeId, projectId)
      // Reverse order: source=main, target=feature-branch
      const mainBranch = 'main' // Could detect main/master
      setBranches(mainBranch, featureBranch)
    }
  }, [isOpen, worktreeId, projectId, featureBranch, setWorktreeContext, setBranches])

  // Handle Escape key
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel()
    } else if (e.key === 'Enter' && !isMerging) {
      handleNext()
    }
  }, [isMerging, onCancel])

  // Handle Next button (simplified - workflow state managed inline)
  const handleNext = useCallback(async () => {
    // Workflow transitions
    if (detectionResult === null) {
      // Go to conflict detection
      if (sourceBranch && targetBranch) {
        await detectConflicts(projectId, sourceBranch, targetBranch)
      }
    } else if (mergePreview === null) {
      // Go to preview
      if (sourceBranch && targetBranch) {
        await getMergePreview(projectId, sourceBranch, targetBranch)
      }
    } else {
      // Go to execute
      await executeMerge()
    }
  }, [sourceBranch, targetBranch, projectId, detectionResult, mergePreview, detectConflicts, getMergePreview, executeMerge])

  // Handle retry after error
  const handleRetry = useCallback(() => {
    clearError()
    executeMerge()
  }, [clearError, executeMerge])

  // Handle complete workflow
  const handleComplete = useCallback(() => {
    onComplete?.()
  }, [onComplete])

  if (!isOpen) return null

  const hasDetection = detectionResult !== null
  const hasPreview = mergePreview !== null
  const isComplete = mergeResult?.success && !isMerging
  const hasError = mergeError && !isMerging

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
            className="bg-card rounded-lg shadow-2xl w-full max-w-3xl border border-border overflow-hidden flex flex-col max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            tabIndex={-1}
          >
            {/* Header with sync icon */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                  <GitPullRequest className="w-5 h-5 text-blue-500" />
                  Sync Upstream
                </h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Merge main into your feature branch
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

            {/* Content based on current state */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {/* Step 1: Confirmation */}
              {!hasDetection && !hasPreview && !isComplete && !hasError && (
                <SyncConfirmationStep
                  sourceBranch={sourceBranch}
                  targetBranch={targetBranch}
                  hasUncommittedChanges={false}
                />
              )}

              {/* Step 2: Conflict Detection */}
              {hasDetection && !hasPreview && !isComplete && !hasError && (
                <MergeDialog
                  isOpen={true}
                  projectId={projectId}
                  sourceBranch={sourceBranch}
                  targetBranch={targetBranch}
                  onProceed={handleNext}
                  onCancel={onCancel}
                />
              )}

              {/* Step 3: Preview */}
              {hasPreview && !isComplete && !hasError && (
                <MergePreviewDialog
                  isOpen={true}
                  projectId={projectId}
                  sourceBranch={sourceBranch}
                  targetBranch={targetBranch}
                  onProceed={handleNext}
                  onCancel={onCancel}
                />
              )}

              {/* Step 4: Execute */}
              {isMerging && (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 className="w-12 h-12 animate-spin text-blue-500 mb-4" />
                  <p className="text-sm text-muted-foreground">
                    Syncing main into your feature branch...
                  </p>
                </div>
              )}

              {/* Error state */}
              {hasError && (
                <div className="text-center max-w-md">
                  <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
                  <p className="text-sm text-red-500 mb-4">
                    {mergeError}
                  </p>
                  <button
                    onClick={handleRetry}
                    className="px-4 py-2 rounded-md text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                  >
                    Retry
                  </button>
                </div>
              )}

              {/* Complete state */}
              {isComplete && (
                <div className="text-center py-12">
                  <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto mb-4" />
                  <p className="text-lg font-medium text-foreground mb-2">
                    Successfully synced!
                  </p>
                  <p className="text-sm text-muted-foreground mb-1">
                    {sourceBranch} → {targetBranch}
                  </p>
                  <p className="text-xs text-muted-foreground mb-6">
                    Your feature branch now has the latest main changes
                  </p>
                  <button
                    onClick={handleComplete}
                    className="px-6 py-2 rounded-md text-sm font-medium bg-green-500 text-white hover:bg-green-600 transition-colors"
                  >
                    Done
                  </button>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border bg-secondary/20 flex-shrink-0">
              <button
                onClick={onCancel}
                disabled={isMerging}
                className="px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>

              {!isComplete && !hasError && (
                <button
                  onClick={handleNext}
                  disabled={isMerging}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {hasPreview ? (
                    <>
                      Execute Sync
                      <ChevronRight className="w-4 h-4" />
                    </>
                  ) : (
                    <>
                      Next
                      <ChevronRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
})

SyncWorkflowManager.displayName = 'SyncWorkflowManager'
