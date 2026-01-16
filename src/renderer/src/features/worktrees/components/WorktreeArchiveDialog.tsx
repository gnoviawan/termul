/**
 * WorktreeArchiveDialog Component
 *
 * Confirmation dialog for archiving a worktree.
 * Source: Story 1.6 - Task 1.1: Create WorktreeArchiveDialog component
 */

import { memo } from 'react'
import { Archive, Clock, GitBranch } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { FreshnessIndicator } from './FreshnessIndicator'
import type { WorktreeMetadata } from '../../worktree.types'

export interface WorktreeArchiveDialogProps {
  isOpen: boolean
  worktree: WorktreeMetadata | null
  onConfirm: () => void
  onCancel: () => void
}

/**
 * WorktreeArchiveDialog - Confirmation dialog for archiving worktrees
 */
export const WorktreeArchiveDialog = memo(({
  isOpen,
  worktree,
  onConfirm,
  onCancel
}: WorktreeArchiveDialogProps) => {
  // Handle Escape key to close dialog
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel()
    } else if (e.key === 'Enter') {
      onConfirm()
    }
  }

  if (!worktree) return null

  const archivePath = `${worktree.worktreePath}/../archives/${worktree.branchName}-${Date.now()}`

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
          onClick={onCancel}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl w-[480px] border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            tabIndex={-1}
          >
            {/* Header */}
            <div className="p-6 pb-4">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center">
                  <Archive className="w-5 h-5 text-blue-500" />
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-foreground mb-1">Archive Worktree</h3>
                  <p className="text-sm text-muted-foreground">
                    Archive this worktree to free up space while keeping it for 30 days
                  </p>
                </div>
              </div>
            </div>

            {/* Worktree Details */}
            <div className="px-6 pb-4">
              <div className="bg-secondary/30 rounded-lg p-4 space-y-3">
                {/* Branch Name */}
                <div className="flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{worktree.branchName}</span>
                </div>

                {/* Last Accessed */}
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                  <div className="flex-1">
                    <FreshnessIndicator
                      lastAccessedAt={worktree.lastAccessedAt}
                      variant="minimal"
                      className="text-xs"
                      showIcon={false}
                    />
                  </div>
                </div>

                {/* Archive Destination */}
                <div className="pt-2 border-t border-border/50">
                  <p className="text-xs text-muted-foreground mb-1">Archive destination:</p>
                  <p className="text-xs font-mono bg-background rounded px-2 py-1 truncate" title={archivePath}>
                    {archivePath}
                  </p>
                </div>
              </div>
            </div>

            {/* Info Message */}
            <div className="px-6 pb-4">
              <div className="flex items-start gap-2 text-xs text-muted-foreground bg-blue-500/5 border border-blue-500/20 rounded px-3 py-2">
                <span>ℹ️</span>
                <span>Archived worktrees are kept for 30 days before automatic cleanup. You can restore anytime during this period.</span>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
              <button
                onClick={onCancel}
                className="px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                className="px-4 py-2 text-xs font-medium rounded bg-blue-500 text-white hover:bg-blue-600 transition-colors"
              >
                Archive Worktree
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
})

WorktreeArchiveDialog.displayName = 'WorktreeArchiveDialog'
