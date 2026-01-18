/**
 * Merge Workflow Manager Component
 *
 * State machine container for merge workflow with steps:
 * 1. Select target branch
 * 2. Conflict detection (Story 2.2)
 * 3. Merge preview (Story 2.3)
 * 4. Merge validation (Story 2.6)
 * 5. Execute merge
 * Source: Story 2.4 - Merge Workflow: Worktree to Main
 */

import { memo, useEffect, useCallback, useState } from 'react'
import { X, ChevronLeft, ChevronRight } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useMergeStore, useWorkflowState, useSourceBranch, useTargetBranch, useIsMerging, useMergeError, useMergeResult, useDetectionResult, useMergePreview, useMergeProgress, useMergeStep, useMergeActions } from '@/stores/merge-store'
import { BranchSelectionStep } from './BranchSelectionStep'
import { MergeDialog } from './MergeDialog'
import { MergePreviewDialog } from './MergePreviewDialog'
import { MergeValidationStep } from './MergeValidationStep'
import { MergeConfirmationDialog } from './MergeConfirmationDialog'
import { MergeProgressDialog } from './MergeProgressDialog'
import { MergeSuccessDialog } from './MergeSuccessDialog'
import { MergeErrorDialog } from './MergeErrorDialog'
import type { WorkflowState } from '@/stores/merge-store'

export interface MergeWorkflowManagerProps {
  isOpen: boolean
  worktreeId: string
  sourceBranch: string
  projectId: string
  onComplete?: () => void
  onCancel: () => void
}

/**
 * Workflow step configuration
 */
const WORKFLOW_STEPS = [
  { id: 'select-branch' as WorkflowState, label: 'Select Branch', icon: '🌿' },
  { id: 'detect-conflicts' as WorkflowState, label: 'Detect Conflicts', icon: '🔍' },
  { id: 'preview' as WorkflowState, label: 'Preview', icon: '👁️' },
  { id: 'validate' as WorkflowState, label: 'Validate', icon: '✓' },
  { id: 'execute' as WorkflowState, label: 'Execute', icon: '⚡' },
  { id: 'complete' as WorkflowState, label: 'Complete', icon: '✅' }
] as const

/**
 * Get step index from workflow state
 */
function getStepIndex(state: WorkflowState): number {
  return WORKFLOW_STEPS.findIndex(step => step.id === state)
}

/**
 * Check if can proceed to next step
 */
function canProceed(state: WorkflowState, hasDetection: boolean, hasPreview: boolean, canMerge: boolean): boolean {
  switch (state) {
    case 'select-branch':
      return true // Can always proceed after selecting branches
    case 'detect-conflicts':
      return hasDetection
    case 'preview':
      return hasPreview
    case 'validate':
      return canMerge
    case 'execute':
      return true // Validation passed
    default:
      return false
  }
}

/**
 * MergeWorkflowManager - Main merge workflow container
 *
 * Manages the step-by-step merge workflow:
 * - Step indicator showing progress
 * - Navigation with Next/Back/Cancel buttons
 * - Error handling and recovery
 * - Completion handling
 */
export const MergeWorkflowManager = memo(({
  isOpen,
  worktreeId,
  sourceBranch: initialSourceBranch,
  projectId,
  onComplete,
  onCancel
}: MergeWorkflowManagerProps) => {
  const workflowState = useWorkflowState()
  const sourceBranch = useSourceBranch()
  const targetBranch = useTargetBranch()
  const isMerging = useIsMerging()
  const mergeError = useMergeError()
  const mergeResult = useMergeResult()
  const detectionResult = useDetectionResult()
  const mergePreview = useMergePreview()
  const mergeProgress = useMergeProgress()
  const mergeStep = useMergeStep()

  // Local state for dialogs (Story 2.6)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [showError, setShowError] = useState(false)

  const {
    setWorkflowState,
    setBranches,
    setWorktreeContext,
    detectConflicts,
    getMergePreview,
    executeMerge,
    resetWorkflow,
    clearError,
    setMergeProgress,
    setMergeStep
  } = useMergeActions()

  // Initialize workflow on mount
  useEffect(() => {
    if (isOpen && workflowState === 'idle') {
      setWorktreeContext(worktreeId, projectId)
      setBranches(initialSourceBranch, '')
      setWorkflowState('select-branch')
    }
  }, [isOpen, workflowState, worktreeId, projectId, initialSourceBranch, setWorktreeContext, setBranches, setWorkflowState])

  // Reset on unmount
  useEffect(() => {
    return () => {
      if (isOpen) {
        resetWorkflow()
      }
    }
  }, [isOpen, resetWorkflow])

  // Pure callbacks (no dependencies)
  const handleConfirmCancel = useCallback(() => {
    setShowConfirmation(false)
  }, [])

  // Store-action callbacks
  const handleNext = useCallback(async () => {
    switch (workflowState) {
      case 'select-branch':
        setWorkflowState('detect-conflicts')
        // Auto-detect conflicts when entering this step
        if (sourceBranch && targetBranch) {
          await detectConflicts(projectId, sourceBranch, targetBranch)
        }
        break
      case 'detect-conflicts':
        setWorkflowState('preview')
        if (sourceBranch && targetBranch) {
          await getMergePreview(projectId, sourceBranch, targetBranch)
        }
        break
      case 'preview':
        setWorkflowState('validate')
        break
      case 'validate':
        // Show confirmation dialog before execute (Story 2.6)
        setShowConfirmation(true)
        break
      case 'execute':
      case 'complete':
        // Already at end
        break
    }
  }, [workflowState, sourceBranch, targetBranch, projectId, detectConflicts, getMergePreview, setWorkflowState])

  const handleConfirmMerge = useCallback(async () => {
    setShowConfirmation(false)
    setWorkflowState('execute')

    // Progress tracking (Story 2.6)
    setMergeStep('preparing')
    setMergeProgress(10)

    await new Promise(resolve => setTimeout(resolve, 500))
    setMergeStep('merging')
    setMergeProgress(30)

    await executeMerge()

    setMergeStep('finalizing')
    setMergeProgress(90)
  }, [setWorkflowState, setMergeStep, setMergeProgress, executeMerge])

  const handleComplete = useCallback(() => {
    try {
      // Call parent callback first while merge state is still available
      onComplete?.()
    } catch (error) {
      console.error('[MergeWorkflowManager] onComplete callback failed:', error)
    } finally {
      // Reset workflow state after callback completes
      resetWorkflow()
    }
  }, [resetWorkflow, onComplete])

  const handleErrorClose = useCallback(() => {
    setShowError(false)
    clearError()
  }, [clearError])

  const handleErrorRetry = useCallback(() => {
    setShowError(false)
    clearError()
    executeMerge()
  }, [clearError, executeMerge])

  const handleBack = useCallback(() => {
    const currentIndex = getStepIndex(workflowState)
    if (currentIndex > 0) {
      setWorkflowState(WORKFLOW_STEPS[currentIndex - 1].id)
    }
  }, [workflowState, setWorkflowState])

  // Callback-dependent callbacks
  const handleSuccessClose = useCallback(() => {
    setShowSuccess(false)
    handleComplete()
  }, [handleComplete])

  // Event handlers
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel()
    } else if (e.key === 'Enter' && !isMerging) {
      handleNext()
    } else if (e.key === 'Backspace' && !e.shiftKey && !isMerging) {
      handleBack()
    }
  }, [isMerging, onCancel, handleNext, handleBack])

  // Watch for merge completion to show success/error dialogs (Story 2.6)
  useEffect(() => {
    if (workflowState === 'execute' && !isMerging) {
      setMergeProgress(100)
      setMergeStep('complete')

      if (mergeResult?.success) {
        setShowSuccess(true)
      } else if (mergeError) {
        setShowError(true)
      }
    }
  }, [workflowState, isMerging, mergeResult, mergeError, setMergeProgress, setMergeStep])

  // Watch for merge start to show progress dialog
  useEffect(() => {
    if (workflowState === 'execute' && isMerging) {
      setMergeStep('merging')
      setMergeProgress(50)
    }
  }, [workflowState, isMerging, setMergeStep, setMergeProgress])

  if (!isOpen) return null

  const currentStepIndex = getStepIndex(workflowState)
  const canProceedNext = canProceed(workflowState, !!detectionResult, !!mergePreview, true)
  const canGoBack = currentStepIndex > 0

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
            {/* Header with step indicator */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-foreground">
                  Merge to Main
                </h2>
                {/* Step indicator */}
                <div className="flex items-center gap-2 mt-2">
                  {WORKFLOW_STEPS.slice(0, -1).map((step, index) => {
                    const isCompleted = index < currentStepIndex
                    const isCurrent = index === currentStepIndex
                    const isPending = index > currentStepIndex

                    return (
                      <div key={step.id} className="flex items-center gap-1">
                        <div className={cn(
                          'w-6 h-6 rounded-full flex items-center justify-center text-xs',
                          isCompleted && 'bg-green-500 text-white',
                          isCurrent && 'bg-blue-500 text-white',
                          isPending && 'bg-secondary text-muted-foreground'
                        )}>
                          {isCompleted ? '✓' : index + 1}
                        </div>
                        <span className={cn(
                          'text-xs',
                          isCurrent ? 'text-foreground font-medium' : 'text-muted-foreground'
                        )}>
                          {step.label}
                        </span>
                        {index < WORKFLOW_STEPS.slice(0, -1).length - 1 && (
                          <ChevronRight className="w-3 h-3 text-muted-foreground" />
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
              <button
                onClick={onCancel}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content based on current step */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {workflowState === 'select-branch' && (
                <BranchSelectionStep
                  sourceBranch={sourceBranch}
                  targetBranch={targetBranch}
                  onSourceChange={(branch) => setBranches(branch, targetBranch)}
                  onTargetChange={(branch) => setBranches(sourceBranch, branch)}
                />
              )}

              {workflowState === 'detect-conflicts' && (
                <MergeDialog
                  isOpen={true}
                  projectId={projectId}
                  sourceBranch={sourceBranch}
                  targetBranch={targetBranch}
                  onProceed={handleNext}
                  onCancel={onCancel}
                />
              )}

              {workflowState === 'preview' && (
                <MergePreviewDialog
                  isOpen={true}
                  projectId={projectId}
                  sourceBranch={sourceBranch}
                  targetBranch={targetBranch}
                  onProceed={handleNext}
                  onCancel={onCancel}
                />
              )}

              {workflowState === 'validate' && (
                <MergeValidationStep
                  sourceBranch={sourceBranch}
                  targetBranch={targetBranch}
                  projectId={projectId}
                  onExecute={handleNext}
                  onBack={handleBack}
                  onCancel={onCancel}
                />
              )}

              {workflowState === 'execute' && (
                <div className="flex flex-col items-center justify-center py-12">
                  <p className="text-sm text-muted-foreground">
                    Executing merge... See progress dialog for details.
                  </p>
                </div>
              )}
            </div>

            {/* Footer with navigation */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-secondary/20 flex-shrink-0">
              <button
                onClick={handleBack}
                disabled={!canGoBack || isMerging}
                className="px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                <ChevronLeft className="w-4 h-4" />
                Back
              </button>

              <div className="flex items-center gap-3">
                <button
                  onClick={onCancel}
                  disabled={isMerging}
                  className="px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>

                {(workflowState === 'select-branch' || workflowState === 'detect-conflicts' || workflowState === 'preview' || workflowState === 'validate') && (
                  <button
                    onClick={handleNext}
                    disabled={!canProceedNext || isMerging}
                    className="px-4 py-2 rounded-md text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {workflowState === 'validate' ? (
                      <>
                        Execute
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
            </div>
          </motion.div>

          {/* Story 2.6: Merge validation dialogs */}
          <MergeConfirmationDialog
            isOpen={showConfirmation}
            sourceBranch={sourceBranch}
            targetBranch={targetBranch}
            fileCount={mergePreview?.fileCount || 0}
            commitCount={mergePreview?.commitCount || 0}
            conflictCount={detectionResult?.conflictCount || 0}
            onConfirm={handleConfirmMerge}
            onCancel={handleConfirmCancel}
          />

          <MergeProgressDialog
            isOpen={workflowState === 'execute' && isMerging}
            currentStep={mergeStep}
            progress={mergeProgress}
          />

          <MergeSuccessDialog
            isOpen={showSuccess}
            sourceBranch={sourceBranch}
            targetBranch={targetBranch}
            onClose={handleSuccessClose}
          />

          <MergeErrorDialog
            isOpen={showError}
            error={mergeError || 'Merge failed'}
            errorDetails={mergeResult?.errorDetails}
            logs={mergeResult?.logs}
            onClose={handleErrorClose}
            onRetry={handleErrorRetry}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
})

MergeWorkflowManager.displayName = 'MergeWorkflowManager'
