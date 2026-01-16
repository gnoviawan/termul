/**
 * WorktreeDeleteDialog Component
 *
 * Multi-stage confirmation dialog for deleting a worktree with safety checks.
 * Source: Story 1.6 - Task 1.2: Create WorktreeDeleteDialog component
 */

import { memo, useState, useCallback } from 'react'
import { Trash2, AlertTriangle, GitBranch, Clock, Check } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { FreshnessIndicator } from './FreshnessIndicator'
import type { WorktreeMetadata } from '../../worktree.types'

export interface WorktreeDeleteDialogProps {
  isOpen: boolean
  worktree: WorktreeMetadata | null
  hasUnpushedCommits?: boolean
  unpushedCommitCount?: number
  isMainBranch?: boolean
  onConfirm: (options: { deleteBranch?: boolean }) => void
  onCancel: () => void
}

type ConfirmStage = 'warning' | 'unpushed' | 'main-branch' | 'final'

/**
 * WorktreeDeleteDialog - Multi-stage confirmation for worktree deletion
 */
export const WorktreeDeleteDialog = memo(({
  isOpen,
  worktree,
  hasUnpushedCommits = false,
  unpushedCommitCount = 0,
  isMainBranch = false,
  onConfirm,
  onCancel
}: WorktreeDeleteDialogProps) => {
  const [stage, setStage] = useState<ConfirmStage>('warning')
  const [branchConfirmation, setBranchConfirmation] = useState('')
  const [deleteBranch, setDeleteBranch] = useState(false)

  // Reset state when dialog opens/closes
  const resetState = useCallback(() => {
    setStage('warning')
    setBranchConfirmation('')
    setDeleteBranch(false)
  }, [])

  // Handle Escape key to close dialog
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      resetState()
      onCancel()
    }
  }, [onCancel, resetState])

  const handleNext = useCallback(() => {
    if (stage === 'warning') {
      if (hasUnpushedCommits) {
        setStage('unpushed')
      } else if (isMainBranch) {
        setStage('main-branch')
      } else {
        setStage('final')
      }
    } else if (stage === 'unpushed') {
      if (isMainBranch) {
        setStage('main-branch')
      } else {
        setStage('final')
      }
    } else if (stage === 'main-branch') {
      setStage('final')
    }
  }, [stage, hasUnpushedCommits, isMainBranch])

  const handleConfirm = useCallback(() => {
    onConfirm({ deleteBranch })
    resetState()
  }, [onConfirm, deleteBranch, resetState])

  if (!worktree) return null

  const canConfirmMainBranch = branchConfirmation.toLowerCase() === worktree.branchName.toLowerCase()

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
          onClick={() => {
            resetState()
            onCancel()
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl w-[500px] border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            tabIndex={-1}
          >
            {/* Header */}
            <div className="p-6 pb-4">
              <div className="flex items-start gap-4">
                <div className={cn(
                  'flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
                  stage === 'main-branch' || stage === 'unpushed'
                    ? 'bg-orange-500/10'
                    : 'bg-red-500/10'
                )}>
                  {stage === 'main-branch' || stage === 'unpushed' ? (
                    <AlertTriangle className="w-5 h-5 text-orange-500" />
                  ) : (
                    <Trash2 className="w-5 h-5 text-red-500" />
                  )}
                </div>
                <div className="flex-1">
                  <h3 className={cn(
                    'text-sm font-semibold mb-1',
                    stage === 'main-branch' || stage === 'unpushed'
                      ? 'text-orange-500'
                      : 'text-red-500'
                  )}>
                    {stage === 'main-branch' && '⚠️ Main Branch Warning'}
                    {stage === 'unpushed' && '⚠️ Unpushed Commits'}
                    {stage === 'final' && '⚠️ Permanently Delete Worktree'}
                    {stage === 'warning' && 'Delete Worktree'}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {stage === 'warning' && 'This action cannot be undone. Please review the details below.'}
                    {stage === 'unpushed' && `This worktree has ${unpushedCommitCount} unpushed commit(s). Deleting it will lose these changes.`}
                    {stage === 'main-branch' && `You are about to delete the main branch worktree. This is unusual and potentially dangerous.`}
                    {stage === 'final' && 'Confirm the final details to proceed with deletion.'}
                  </p>
                </div>
              </div>
            </div>

            {/* Content based on stage */}
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

                {/* Stage-specific warnings */}
                {stage === 'unpushed' && (
                  <div className="pt-2 border-t border-border/50">
                    <div className="flex items-start gap-2 text-xs text-orange-400">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      <span>
                        <strong>Warning:</strong> {unpushedCommitCount} commit(s) will be permanently lost.
                      </span>
                    </div>
                  </div>
                )}

                {stage === 'main-branch' && (
                  <div className="pt-2 border-t border-border/50">
                    <div className="flex items-start gap-2 text-xs text-orange-400">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                      <span>
                        <strong>Danger:</strong> Deleting main/master branch worktrees can cause issues.
                        Type the branch name to confirm: <code className="bg-background px-1.5 py-0.5 rounded">{worktree.branchName}</code>
                      </span>
                    </div>
                    <input
                      type="text"
                      value={branchConfirmation}
                      onChange={(e) => setBranchConfirmation(e.target.value)}
                      placeholder={`Type "${worktree.branchName}" to confirm`}
                      className="mt-2 w-full bg-background border border-border rounded px-3 py-2 text-sm focus:ring-2 focus:ring-orange-500 outline-none"
                      autoFocus
                    />
                  </div>
                )}

                {stage === 'final' && (
                  <div className="pt-2 border-t border-border/50">
                    <label className="flex items-start gap-3 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={deleteBranch}
                        onChange={(e) => setDeleteBranch(e.target.checked)}
                        className="mt-0.5 w-4 h-4 rounded border-border bg-background"
                      />
                      <div className="flex-1">
                        <span className="text-sm font-medium group-hover:text-foreground text-foreground/80">
                          Also delete local branch "{worktree.branchName}"
                        </span>
                        <p className="text-xs text-muted-foreground mt-1">
                          This will run <code className="bg-background px-1 rounded">git branch -D {worktree.branchName}</code>
                        </p>
                      </div>
                    </label>
                  </div>
                )}
              </div>
            </div>

            {/* Progress indicator */}
            <div className="px-6 pb-4">
              <div className="flex items-center gap-2">
                <div className={cn(
                  'h-1.5 flex-1 rounded-full bg-secondary',
                  stage === 'warning' && 'w-1/3 bg-red-500',
                  stage === 'unpushed' && 'w-2/3 bg-orange-500',
                  stage === 'main-branch' && 'w-2/3 bg-orange-500',
                  stage === 'final' && 'bg-red-500'
                )} />
                <div className="flex gap-1">
                  <div className={cn(
                    'w-2 h-2 rounded-full',
                    stage === 'warning' || stage === 'unpushed' || stage === 'main-branch' || stage === 'final'
                      ? 'bg-red-500'
                      : 'bg-secondary'
                  )} />
                  <div className={cn(
                    'w-2 h-2 rounded-full',
                    stage === 'unpushed' || stage === 'main-branch' || stage === 'final'
                      ? 'bg-orange-500'
                      : 'bg-secondary'
                  )} />
                  <div className={cn(
                    'w-2 h-2 rounded-full',
                    stage === 'main-branch' || stage === 'final'
                      ? 'bg-orange-500'
                      : 'bg-secondary'
                  )} />
                  <div className={cn(
                    'w-2 h-2 rounded-full',
                    stage === 'final'
                      ? 'bg-red-500'
                      : 'bg-secondary'
                  )} />
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
              <button
                onClick={() => {
                  resetState()
                  onCancel()
                }}
                className="px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={stage === 'final' ? handleConfirm : handleNext}
                disabled={stage === 'main-branch' && !canConfirmMainBranch}
                className={cn(
                  'px-4 py-2 text-xs font-medium rounded transition-colors',
                  stage === 'main-branch' || stage === 'unpushed'
                    ? 'bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50 disabled:cursor-not-allowed'
                    : 'bg-red-500 text-white hover:bg-red-600'
                )}
              >
                {stage === 'warning' && 'Continue'}
                {stage === 'unpushed' && 'Continue'}
                {stage === 'main-branch' && 'Confirm'}
                {stage === 'final' && 'Delete Worktree'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
})

WorktreeDeleteDialog.displayName = 'WorktreeDeleteDialog'
