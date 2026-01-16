/**
 * Merge Confirmation Dialog Component
 *
 * Final confirmation before merge execution with isProtected branch validation.
 * Requires typing branch name for isProtected branches (main/master).
 * Source: Story 2.6 - Task 1-2: Create MergeConfirmationDialog Component
 */

import { memo, useState, useCallback, useEffect } from 'react'
import { AlertTriangle, Shield, GitBranch, File, GitCommit, AlertCircle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

export interface MergeConfirmationDialogProps {
  isOpen: boolean
  sourceBranch: string
  targetBranch: string
  fileCount: number
  commitCount: number
  conflictCount: number
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Check if branch is a isProtected branch (requires extra confirmation)
 */
function checkIsProtectedBranch(branchName: string): boolean {
  const isProtectedBranches = ['main', 'master', 'develop', 'development']
  return isProtectedBranches.includes(branchName.toLowerCase())
}

/**
 * MergeConfirmationDialog - Final confirmation before merge
 *
 * Features:
 * - Shows merge summary: files, commits, conflicts
 * - Large clear target branch display
 * - Protected branch detection and extra confirmation
 * - "Type branch name to confirm" for isProtected branches
 * - Input validation before enabling confirm button
 */
export const MergeConfirmationDialog = memo(({
  isOpen,
  sourceBranch,
  targetBranch,
  fileCount,
  commitCount,
  conflictCount,
  onConfirm,
  onCancel
}: MergeConfirmationDialogProps) => {
  const [confirmationInput, setConfirmationInput] = useState('')
  const [inputError, setInputError] = useState('')

  const isProtected = checkIsProtectedBranch(targetBranch)

  // Validate input matches target branch
  const isConfirmed = !isProtected || confirmationInput === targetBranch

  // Reset input when dialog opens/closes or branches change
  useEffect(() => {
    if (!isOpen) {
      setConfirmationInput('')
      setInputError('')
    }
  }, [isOpen])

  useEffect(() => {
    setConfirmationInput('')
    setInputError('')
  }, [sourceBranch, targetBranch])

  // Handle confirm click
  const handleConfirm = useCallback(() => {
    if (!isConfirmed) {
      setInputError('Branch name does not match. Please type the exact target branch name.')
      return
    }
    onConfirm()
  }, [isConfirmed, onConfirm])

  // Handle input change
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setConfirmationInput(e.target.value)
    setInputError('')
  }, [])

  // Handle keyboard
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onCancel()
    } else if (e.key === 'Enter' && isConfirmed) {
      handleConfirm()
    }
  }, [isConfirmed, handleConfirm, onCancel])

  if (!isOpen) return null

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
            className="bg-card rounded-lg shadow-2xl w-full max-w-md border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            tabIndex={-1}
          >
            {/* Header */}
            <div className="px-6 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                <div className={cn(
                  "p-2 rounded-lg",
                  isProtected ? "bg-red-500/10" : "bg-blue-500/10"
                )}>
                  {isProtected ? (
                    <Shield className="w-5 h-5 text-red-500" />
                  ) : (
                    <GitBranch className="w-5 h-5 text-blue-500" />
                  )}
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-foreground">
                    {isProtected ? 'Protected Branch Merge' : 'Confirm Merge'}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {isProtected ? 'Extra confirmation required' : 'Review merge details before proceeding'}
                  </p>
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="px-6 py-4 space-y-4">
              {/* Protected branch warning */}
              {isProtected && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-start gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20"
                >
                  <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-red-500">You are merging to a isProtected branch</p>
                    <p className="text-red-500/80 mt-1">
                      This operation will modify <code className="font-mono">{targetBranch}</code>. Please type the branch name to confirm.
                    </p>
                  </div>
                </motion.div>
              )}

              {/* Merge summary */}
              <div className="space-y-3">
                <p className="text-sm text-foreground">
                  Merge <code className="font-mono px-1.5 py-0.5 rounded bg-secondary text-foreground">{sourceBranch}</code> into:
                </p>

                {/* Large target branch display */}
                <div className={cn(
                  "p-4 rounded-lg border-2 text-center",
                  isProtected ? "bg-red-500/5 border-red-500/30" : "bg-blue-500/5 border-blue-500/30"
                )}>
                  <code className={cn(
                    "text-2xl font-mono font-semibold",
                    isProtected ? "text-red-500" : "text-blue-500"
                  )}>
                    {targetBranch}
                  </code>
                </div>

                {/* Change counts */}
                <div className="grid grid-cols-3 gap-3 mt-4">
                  <div className="text-center p-3 rounded-lg bg-secondary/20">
                    <File className="w-5 h-5 mx-auto mb-1 text-blue-500" />
                    <p className="text-lg font-semibold text-foreground">{fileCount}</p>
                    <p className="text-xs text-muted-foreground">Files</p>
                  </div>
                  <div className="text-center p-3 rounded-lg bg-secondary/20">
                    <GitCommit className="w-5 h-5 mx-auto mb-1 text-green-500" />
                    <p className="text-lg font-semibold text-foreground">{commitCount}</p>
                    <p className="text-xs text-muted-foreground">Commits</p>
                  </div>
                  <div className={cn(
                    "text-center p-3 rounded-lg",
                    conflictCount > 0 ? "bg-red-500/10 border border-red-500/20" : "bg-secondary/20"
                  )}>
                    <AlertCircle className={cn(
                      "w-5 h-5 mx-auto mb-1",
                      conflictCount > 0 ? "text-red-500" : "text-gray-500"
                    )} />
                    <p className={cn(
                      "text-lg font-semibold",
                      conflictCount > 0 ? "text-red-500" : "text-foreground"
                    )}>
                      {conflictCount}
                    </p>
                    <p className="text-xs text-muted-foreground">Conflicts</p>
                  </div>
                </div>
              </div>

              {/* Branch name confirmation input */}
              {isProtected && (
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">
                    Type <code className="font-mono px-1 py-0.5 rounded bg-secondary">{targetBranch}</code> to confirm:
                  </label>
                  <input
                    type="text"
                    value={confirmationInput}
                    onChange={handleInputChange}
                    placeholder={targetBranch}
                    className={cn(
                      "w-full px-4 py-2 rounded-md border bg-background text-foreground",
                      "placeholder:text-muted-foreground",
                      "focus:outline-none focus:ring-2 focus:ring-blue-500",
                      inputError && "border-red-500"
                    )}
                    autoFocus
                  />
                  {inputError && (
                    <motion.p
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className="text-xs text-red-500"
                    >
                      {inputError}
                    </motion.p>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border bg-secondary/20">
              <button
                onClick={onCancel}
                className="px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={!isConfirmed}
                className={cn(
                  "px-4 py-2 rounded-md text-sm font-medium transition-colors",
                  "disabled:opacity-50 disabled:cursor-not-allowed",
                  isProtected
                    ? "bg-red-500 text-white hover:bg-red-600"
                    : "bg-blue-500 text-white hover:bg-blue-600"
                )}
              >
                {isProtected ? 'Confirm Protected Merge' : 'Confirm Merge'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
})

MergeConfirmationDialog.displayName = 'MergeConfirmationDialog'
