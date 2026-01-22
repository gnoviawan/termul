/**
 * Merge Dialog Component
 *
 * Main merge workflow dialog that integrates detection mode selection,
 * conflict detection, and results display.
 * Source: Story 2.2 - Task 7: Integrate into Merge Dialog Workflow
 */

import { memo, useEffect, useCallback } from 'react'
import { X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { DetectionModeSelector, ConflictDetectionResults } from './index'
import { useMergeStore, useDetectionState, useMergeActions, useDetectionMode, usePreferenceLoaded } from '@/stores/merge-store'

export interface MergeDialogProps {
  isOpen: boolean
  projectId: string
  sourceBranch: string
  targetBranch: string
  onProceed?: () => void
  onCancel: () => void
}

/**
 * MergeDialog - Main merge workflow dialog
 *
 * Workflow steps:
 * 1. Select detection mode
 * 2. Run conflict detection
 * 3. Review results
 * 4. Proceed to merge preview (via onProceed)
 */
export const MergeDialog = memo(({
  isOpen,
  projectId,
  sourceBranch,
  targetBranch,
  onProceed,
  onCancel
}: MergeDialogProps) => {
  const detectionMode = useDetectionMode()
  const { isDetecting, result, error } = useDetectionState()
  const { detectConflicts, loadPreference, clearResults, clearError } = useMergeActions()
  const preferenceLoaded = usePreferenceLoaded()

  // Load preference on mount (AC7, AC8)
  useEffect(() => {
    if (isOpen && !preferenceLoaded) {
      loadPreference()
    }
  }, [isOpen, preferenceLoaded, loadPreference])

  // Clear results when dialog closes
  useEffect(() => {
    if (!isOpen) {
      clearResults()
    }
  }, [isOpen, clearResults])

  // Handle Escape key
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel()
    }
  }, [onCancel])

  // Handle detect conflicts button click
  const handleDetectConflicts = useCallback(async () => {
    await detectConflicts(projectId, sourceBranch, targetBranch)
  }, [projectId, sourceBranch, targetBranch, detectConflicts])

  // Handle retry
  const handleRetry = useCallback(async () => {
    clearError()
    await detectConflicts(projectId, sourceBranch, targetBranch)
  }, [detectConflicts, projectId, sourceBranch, targetBranch, clearError])

  // Handle proceed to next step
  const handleProceed = useCallback(() => {
    onProceed?.()
  }, [onProceed])

  if (!isOpen) return null

  const canProceed = result && !result.hasConflicts && !isDetecting && !error
  const hasConflicts = result && result.hasConflicts

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
            className="bg-card rounded-lg shadow-2xl w-full max-w-lg border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            tabIndex={-1}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  Merge Conflict Detection
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
            <div className="px-6 py-4 space-y-6">
              {/* Detection Mode Selector */}
              <DetectionModeSelector
                selectedMode={detectionMode}
                onModeChange={() => {}}
                disabled={isDetecting}
              />

              {/* Detection Results */}
              <ConflictDetectionResults
                result={result}
                isLoading={isDetecting}
                error={error}
                onRetry={handleRetry}
                detectionMode={detectionMode}
              />
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border bg-secondary/20">
              <button
                onClick={onCancel}
                disabled={isDetecting}
                className="px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>

              {/* Detect button - shown when no results yet */}
              {!result && !isDetecting && !error && (
                <button
                  onClick={handleDetectConflicts}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                >
                  Detect Conflicts
                </button>
              )}

              {/* Retry button - shown on error */}
              {error && (
                <button
                  onClick={handleRetry}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 transition-colors"
                >
                  Retry
                </button>
              )}

              {/* Proceed button - shown when no conflicts detected */}
              {canProceed && (
                <button
                  onClick={handleProceed}
                  className="px-4 py-2 rounded-md text-sm font-medium bg-green-500 text-white hover:bg-green-600 transition-colors"
                >
                  Proceed to Merge Preview
                </button>
              )}

              {/* Cannot proceed message - shown when conflicts exist */}
              {hasConflicts && !isDetecting && (
                <div className="text-sm text-muted-foreground">
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

MergeDialog.displayName = 'MergeDialog'
