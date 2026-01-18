/**
 * Branch Selection Step Component
 *
 * First step in merge workflow: select source and target branches.
 * Source branch is pre-filled with worktree branch, target defaults to main/master.
 * Source: Story 2.4 - Task 3: Create Branch Selection Step
 */

import { memo, useEffect } from 'react'
import { GitBranch, Info } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

export interface BranchSelectionStepProps {
  sourceBranch: string
  targetBranch: string
  onSourceChange: (branch: string) => void
  onTargetChange: (branch: string) => void
  availableBranches?: string[]
}

/**
 * Common branch names for auto-detection
 */
const MAIN_BRANCHES = ['main', 'master', 'develop', 'development']

/**
 * BranchSelectionStep - Branch selection for merge
 *
 * Features:
 * - Source branch pre-filled (read-only display)
 * - Target branch defaults to main/master
 * - Branch validation (source != target)
 * - Info tip about selecting correct branches
 */
export const BranchSelectionStep = memo(({
  sourceBranch,
  targetBranch,
  onSourceChange,
  onTargetChange,
  availableBranches = MAIN_BRANCHES
}: BranchSelectionStepProps) => {
  // Auto-detect default target branch
  const defaultTarget = availableBranches.find(b => MAIN_BRANCHES.includes(b)) || 'main'

  // Initialize target branch if not set (useEffect to avoid setState during render)
  useEffect(() => {
    if (!targetBranch && defaultTarget) {
      onTargetChange(defaultTarget)
    }
  }, [targetBranch, defaultTarget, onTargetChange])

  const isValid = sourceBranch && targetBranch && sourceBranch !== targetBranch

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      {/* Info tip */}
      <div className="flex items-start gap-3 p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
        <Info className="w-5 h-5 text-blue-500 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-blue-500">
          <p className="font-medium mb-1">Merge your feature branch into main</p>
          <p className="opacity-80">
            Select the target branch where your changes will be merged. The source branch is your current worktree branch.
          </p>
        </div>
      </div>

      {/* Source branch (display only) */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground">
          Source Branch (Your Worktree)
        </label>
        <div className="flex items-center gap-2 px-4 py-3 rounded-md bg-muted border border-border">
          <GitBranch className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-mono text-foreground">
            {sourceBranch || 'Not detected'}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          This is the branch containing your changes to be merged.
        </p>
      </div>

      {/* Target branch selection */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground">
          Target Branch
        </label>
        <select
          value={targetBranch}
          onChange={(e) => onTargetChange(e.target.value)}
          className={cn(
            "w-full px-4 py-3 rounded-md bg-background border border-border",
            "text-sm text-foreground font-mono",
            "focus:outline-none focus:ring-2 focus:ring-blue-500",
            "cursor-pointer"
          )}
        >
          <option value="">Select target branch...</option>
          {availableBranches.map(branch => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          The branch that will receive your changes. Typically this is <code>main</code> or <code>master</code>.
        </p>
      </div>

      {/* Validation message */}
      {sourceBranch && targetBranch && sourceBranch === targetBranch && (
        <div className="p-3 rounded-md bg-red-500/10 border border-red-500/20">
          <p className="text-sm text-red-500">
            Source and target branches cannot be the same.
          </p>
        </div>
      )}

      {/* Ready indicator */}
      {isValid && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="p-3 rounded-md bg-green-500/10 border border-green-500/20"
        >
          <p className="text-sm text-green-500">
            ✓ Ready to merge: <span className="font-mono">{sourceBranch}</span> → <span className="font-mono">{targetBranch}</span>
          </p>
        </motion.div>
      )}
    </motion.div>
  )
})

BranchSelectionStep.displayName = 'BranchSelectionStep'
