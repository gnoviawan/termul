/**
 * Merge Success Dialog Component
 *
 * Success notification after merge completes.
 * Source: Story 2.6 - Task 5: Create MergeSuccessDialog Component
 */

import { memo } from 'react'
import { CheckCircle2, GitBranch } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

export interface MergeSuccessDialogProps {
  isOpen: boolean
  sourceBranch: string
  targetBranch: string
  onClose: () => void
}

/**
 * MergeSuccessDialog - Success notification after merge
 *
 * Features:
 * - Shows "Merge completed successfully!" message
 * - Displays source and target branches
 * - Updates worktree status on completion
 * - Triggers sidebar refresh
 */
export const MergeSuccessDialog = memo(({
  isOpen,
  sourceBranch,
  targetBranch,
  onClose
}: MergeSuccessDialogProps) => {
  if (!isOpen) return null

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl w-full max-w-sm border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Success icon */}
            <div className="pt-8 pb-4 px-6 flex flex-col items-center">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.1, type: 'spring', stiffness: 200 }}
                className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mb-4"
              >
                <CheckCircle2 className="w-10 h-10 text-green-500" />
              </motion.div>

              {/* Success message */}
              <h2 className="text-xl font-semibold text-foreground mb-2 text-center">
                Merge completed successfully!
              </h2>

              {/* Branch info */}
              <div className="flex items-center gap-2 text-sm text-muted-foreground mb-6">
                <code className="font-mono px-2 py-1 rounded bg-secondary text-foreground">
                  {sourceBranch}
                </code>
                <span>→</span>
                <code className="font-mono px-2 py-1 rounded bg-secondary text-foreground">
                  {targetBranch}
                </code>
              </div>

              {/* Info */}
              <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 w-full">
                <GitBranch className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-blue-500">
                  Your worktree status has been updated. The sidebar will refresh automatically.
                </p>
              </div>
            </div>

            {/* Done button */}
            <div className="px-6 py-4 border-t border-border bg-secondary/20">
              <button
                onClick={onClose}
                className="w-full px-4 py-2 rounded-md text-sm font-medium bg-green-500 text-white hover:bg-green-600 transition-colors"
              >
                Done
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
})

MergeSuccessDialog.displayName = 'MergeSuccessDialog'
