/**
 * Merge Error Dialog Component
 *
 * Error handling dialog for merge failures with actionable steps.
 * Source: Story 2.6 - Task 6: Create MergeErrorDialog Component
 */

import { memo, useState } from 'react'
import { AlertCircle, FileText, XCircle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

export interface MergeErrorDialogProps {
  isOpen: boolean
  error: string
  errorDetails?: string
  logs?: string
  onClose: () => void
  onRetry?: () => void
  onViewLogs?: () => void
}

/**
 * Actionable next steps based on error type
 */
function getActionableSteps(error: string): string[] {
  const lowerError = error.toLowerCase()

  if (lowerError.includes('conflict')) {
    return [
      'Resolve merge conflicts in your worktree',
      'Mark conflicts as resolved using git',
      'Commit the merge resolution',
      'Retry the merge operation'
    ]
  }

  if (lowerError.includes('space') || lowerError.includes('disk')) {
    return [
      'Free up disk space on your system',
      'Clear temporary files and caches',
      'Retry the merge operation'
    ]
  }

  if (lowerError.includes('permission') || lowerError.includes('access')) {
    return [
      'Check file permissions for the repository',
      'Ensure you have write access to the worktree',
      'Try running with elevated permissions if needed'
    ]
  }

  if (lowerError.includes('network') || lowerError.includes('remote')) {
    return [
      'Check your internet connection',
      'Verify remote repository is accessible',
      'Fetch latest changes from remote',
      'Retry the merge operation'
    ]
  }

  // Default actionable steps
  return [
    'Review the error details above',
    'Check the merge logs for more information',
    'Ensure your workspace is in a clean state',
    'Contact support if the issue persists'
  ]
}

/**
 * MergeErrorDialog - Error dialog for merge failures
 *
 * Features:
 * - Clear error message display
 * - Actionable next steps to fix the issue
 * - "View logs" button for detailed error info
 * - Retry option if applicable
 */
export const MergeErrorDialog = memo(({
  isOpen,
  error,
  errorDetails,
  logs,
  onClose,
  onRetry,
  onViewLogs
}: MergeErrorDialogProps) => {
  const [showLogs, setShowLogs] = useState(false)

  const actionableSteps = getActionableSteps(error)

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
            className="bg-card rounded-lg shadow-2xl w-full max-w-lg border border-border overflow-hidden max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-6 py-4 border-b border-border flex items-start gap-3">
              <div className="p-2 rounded-lg bg-red-500/10 flex-shrink-0">
                <AlertCircle className="w-5 h-5 text-red-500" />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-foreground">
                  Merge Failed
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  An error occurred during the merge operation
                </p>
              </div>
              <button
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {/* Error message */}
              <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
                <p className="text-sm text-red-500 font-medium mb-1">Error:</p>
                <p className="text-sm text-red-500">{error}</p>
                {errorDetails && (
                  <p className="text-xs text-red-500/70 mt-2">{errorDetails}</p>
                )}
              </div>

              {/* Actionable steps */}
              <div>
                <h3 className="text-sm font-medium text-foreground mb-2 flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  Next Steps:
                </h3>
                <ol className="space-y-2">
                  {actionableSteps.map((step, index) => (
                    <motion.li
                      key={index}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.05 }}
                      className="flex gap-3 text-sm"
                    >
                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-500/10 text-blue-500 flex items-center justify-center text-xs font-medium">
                        {index + 1}
                      </span>
                      <span className="text-muted-foreground">{step}</span>
                    </motion.li>
                  ))}
                </ol>
              </div>

              {/* Logs section */}
              {logs && (
                <div className="space-y-2">
                  <button
                    onClick={() => setShowLogs(!showLogs)}
                    className="text-sm font-medium text-blue-500 hover:text-blue-600 transition-colors flex items-center gap-1"
                  >
                    <FileText className="w-4 h-4" />
                    {showLogs ? 'Hide' : 'View'} Error Logs
                  </button>
                  {showLogs && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="p-3 rounded-lg bg-black/50 border border-border"
                    >
                      <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono overflow-x-auto">
                        {logs}
                      </pre>
                    </motion.div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border bg-secondary/20">
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="px-4 py-2 rounded-md text-sm font-medium text-foreground hover:bg-secondary/40 transition-colors"
                >
                  Retry
                </button>
              )}
              {onViewLogs && !logs && (
                <button
                  onClick={onViewLogs}
                  className="px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
                >
                  View Logs
                </button>
              )}
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-md text-sm font-medium bg-red-500 text-white hover:bg-red-600 transition-colors"
              >
                Close
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
})

MergeErrorDialog.displayName = 'MergeErrorDialog'
