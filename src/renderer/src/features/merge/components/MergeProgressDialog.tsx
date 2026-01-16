/**
 * Merge Progress Dialog Component
 *
 * Shows progress during merge execution with step indicators.
 * Source: Story 2.6 - Task 4: Create MergeProgressDialog Component
 */

import { memo } from 'react'
import { Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

export interface MergeProgressDialogProps {
  isOpen: boolean
  currentStep: 'preparing' | 'merging' | 'finalizing' | 'complete'
  progress: number
}

/**
 * Step labels for each merge phase
 */
const STEP_LABELS: Record<MergeProgressDialogProps['currentStep'], string> = {
  preparing: 'Preparing merge...',
  merging: 'Merging changes...',
  finalizing: 'Finalizing...',
  complete: 'Complete'
}

/**
 * Step descriptions
 */
const STEP_DESCRIPTIONS: Record<MergeProgressDialogProps['currentStep'], string> = {
  preparing: 'Validating workspace and preparing merge operation',
  merging: 'Executing merge and applying changes',
  finalizing: 'Cleaning up and updating worktree status',
  complete: 'Merge completed successfully'
}

/**
 * MergeProgressDialog - Progress indicator during merge execution
 *
 * Features:
 * - Shows current step with description
 * - Progress bar with percentage
 * - Prevents closing during merge (handled by parent)
 * - Visual feedback for each phase
 */
export const MergeProgressDialog = memo(({
  isOpen,
  currentStep,
  progress
}: MergeProgressDialogProps) => {
  if (!isOpen) return null

  const label = STEP_LABELS[currentStep]
  const description = STEP_DESCRIPTIONS[currentStep]

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl w-full max-w-sm border border-border p-6"
          >
            {/* Spinner */}
            <div className="flex flex-col items-center">
              <div className="relative mb-4">
                <Loader2 className="w-12 h-12 text-blue-500 animate-spin" />
                {/* Progress ring */}
                <svg className="absolute inset-0 -rotate-90">
                  <circle
                    cx="24"
                    cy="24"
                    r="20"
                    stroke="currentColor"
                    strokeWidth="3"
                    fill="none"
                    className="text-muted/20"
                  />
                  <circle
                    cx="24"
                    cy="24"
                    r="20"
                    stroke="currentColor"
                    strokeWidth="3"
                    fill="none"
                    strokeDasharray={`${progress * 1.256} 125.6`}
                    className="text-blue-500"
                    style={{ strokeDashoffset: 0 }}
                  />
                </svg>
              </div>

              {/* Step label */}
              <h3 className="text-lg font-semibold text-foreground mb-1">
                {label}
              </h3>

              {/* Step description */}
              <p className="text-sm text-muted-foreground text-center mb-4">
                {description}
              </p>

              {/* Progress bar */}
              <div className="w-full mb-2">
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ duration: 0.3 }}
                    className="h-full bg-blue-500 rounded-full"
                  />
                </div>
              </div>

              {/* Progress percentage */}
              <p className="text-xs text-muted-foreground">
                {Math.round(progress)}%
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
})

MergeProgressDialog.displayName = 'MergeProgressDialog'
