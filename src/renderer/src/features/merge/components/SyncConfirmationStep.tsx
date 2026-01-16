/**
 * Sync Confirmation Step Component
 *
 * First step in sync workflow: confirm sync operation (main → feature-branch).
 * Reverse of merge confirmation - syncs main changes INTO worktree branch.
 * Source: Story 2.5 - Task 3: Create Sync Confirmation Step
 */

import { memo } from 'react'
import { GitBranch, Info, AlertTriangle } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

export interface SyncConfirmationStepProps {
  sourceBranch: string  // main/master
  targetBranch: string  // feature-branch
  hasUncommittedChanges: boolean
}

/**
 * SyncConfirmationStep - Confirm sync upstream operation
 *
 * Features:
 * - Display source branch as main/master (read-only)
 * - Display target branch as worktree's feature branch (read-only)
 * - Show explanatory message about syncing main INTO feature branch
 * - Block sync if worktree has uncommitted changes (AC4)
 */
export const SyncConfirmationStep = memo(({
  sourceBranch,
  targetBranch,
  hasUncommittedChanges
}: SyncConfirmationStepProps) => {
  const canProceed = !hasUncommittedChanges && sourceBranch && targetBranch

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      {/* Info tip - explanatory message */}
      <div className="flex items-start gap-3 p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
        <Info className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-blue-500">
          <p className="font-medium mb-1">Sync main into your feature branch</p>
          <p className="opacity-80">
            This will merge the latest changes from <span className="font-mono">{sourceBranch || 'main'}</span> INTO your feature branch <span className="font-mono">{targetBranch}</span>. Your feature branch commits will be preserved.
          </p>
        </div>
      </div>

      {/* Uncommitted changes warning (AC4) */}
      {hasUncommittedChanges && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-start gap-3 p-4 rounded-lg bg-red-500/10 border border-red-500/20"
        >
          <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-red-500">
            <p className="font-medium mb-1">Cannot sync with uncommitted changes</p>
            <p className="opacity-80">
              You have uncommitted changes in your worktree. Please commit or stash them before syncing upstream.
            </p>
          </div>
        </motion.div>
      )}

      {/* Source branch (display only) - main/master */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground">
          Source Branch (Upstream)
        </label>
        <div className="flex items-center gap-2 px-4 py-3 rounded-md bg-muted border border-border">
          <GitBranch className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-mono text-foreground">
            {sourceBranch || 'main'}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          The upstream branch whose changes will be merged into your feature branch.
        </p>
      </div>

      {/* Target branch (display only) - feature-branch */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground">
          Target Branch (Your Worktree)
        </label>
        <div className="flex items-center gap-2 px-4 py-3 rounded-md bg-muted border border-border">
          <GitBranch className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-mono text-foreground">
            {targetBranch || 'Not detected'}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Your feature branch that will receive the upstream changes.
        </p>
      </div>

      {/* Ready indicator */}
      {canProceed && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="p-3 rounded-md bg-green-500/10 border border-green-500/20"
        >
          <p className="text-sm text-green-500">
            ✓ Ready to sync: <span className="font-mono">{sourceBranch}</span> → <span className="font-mono">{targetBranch}</span>
          </p>
        </motion.div>
      )}

      {/* Blocked indicator */}
      {!canProceed && !hasUncommittedChanges && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="p-3 rounded-md bg-yellow-500/10 border border-yellow-500/20"
        >
          <p className="text-sm text-yellow-500">
            ⚠️ Branch information incomplete. Please ensure both source and target branches are detected.
          </p>
        </motion.div>
      )}
    </motion.div>
  )
})

SyncConfirmationStep.displayName = 'SyncConfirmationStep'
