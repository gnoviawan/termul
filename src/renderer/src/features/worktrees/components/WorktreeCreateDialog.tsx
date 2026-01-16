/**
 * WorktreeCreateDialog Component
 *
 * Modal dialog for creating a new Git worktree from the project sidebar.
 * Allows users to specify branch name and .gitignore patterns to copy.
 * Source: Story 1.4 - Add Create Worktree to Project Context Menu
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { GitBranch, X, Check } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

// Pre-defined .gitignore patterns for selection
// These are common patterns that users typically want to exclude from worktrees
const GITIGNORE_PATTERNS = [
  { pattern: 'node_modules/', label: 'node_modules/', defaultSelected: false },
  { pattern: '.env', label: '.env', defaultSelected: false, warning: 'Contains sensitive credentials' },
  { pattern: 'dist/', label: 'dist/', defaultSelected: false },
  { pattern: 'build/', label: 'build/', defaultSelected: false },
  { pattern: '.git/', label: '.git/', defaultSelected: false }
] as const

// Git branch name validation rules
// Branch names cannot contain: .., ~, ^, :, \, ?, [, *, spaces
// Cannot start or end with /
// Cannot contain consecutive slashes
// Cannot be @, HEAD, or other reserved names
const INVALID_BRANCH_CHARS = /[\.\.~^:\\\?\*\[\s]|^\/|\/$|\/\//
const RESERVED_BRANCH_NAMES = ['HEAD', '@']

function isValidBranchName(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length > 256) return false // Reasonable limit
  if (RESERVED_BRANCH_NAMES.includes(trimmed)) return false
  if (INVALID_BRANCH_CHARS.test(trimmed)) return false
  return true
}

export interface WorktreeCreateDialogProps {
  isOpen: boolean
  projectId: string
  projectName?: string
  projectPath: string // The actual Git repository path
  onClose: () => void
  onSuccess?: (worktreeId: string) => void
  onCreatingChange?: (isCreating: boolean) => void
}

export function WorktreeCreateDialog({
  isOpen,
  projectId,
  projectName,
  projectPath,
  onClose,
  onSuccess,
  onCreatingChange
}: WorktreeCreateDialogProps): React.JSX.Element {
  const [branchName, setBranchName] = useState('')
  const [selectedPatterns, setSelectedPatterns] = useState<Set<string>>(new Set())
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [branchError, setBranchError] = useState<string | null>(null)

  // Track mounted state to prevent memory leak
  const isMountedRef = useRef(true)

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Reset form when modal opens - parent controls reset timing
  useEffect(() => {
    if (isOpen) {
      setBranchName('')
      setSelectedPatterns(new Set())
      setIsCreating(false)
      setError(null)
      setBranchError(null)
    }
  }, [isOpen])

  // Handle Escape key to close modal - with proper cleanup
  useEffect(() => {
    if (!isOpen) return

    const handleEscape = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !isCreating) {
        e.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen, onClose, isCreating])

  // Propagate loading state to parent
  useEffect(() => {
    onCreatingChange?.(isCreating)
  }, [isCreating, onCreatingChange])

  const togglePattern = useCallback((pattern: string): void => {
    setSelectedPatterns((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(pattern)) {
        newSet.delete(pattern)
      } else {
        newSet.add(pattern)
      }
      return newSet
    })
  }, [])

  const selectAllPatterns = useCallback((): void => {
    setSelectedPatterns(new Set(Array.from(GITIGNORE_PATTERNS.map((p) => p.pattern))))
  }, [])

  const deselectAllPatterns = useCallback((): void => {
    setSelectedPatterns(new Set())
  }, [])

  const handleCreate = useCallback(async () => {
    const trimmedBranch = branchName.trim()
    if (!trimmedBranch || isCreating) return

    // Validate branch name
    if (!isValidBranchName(trimmedBranch)) {
      setBranchError('Invalid branch name. Cannot contain: .., ~, ^, :, \\, ?, *, spaces, or start/end with /')
      return
    }

    console.log('[WorktreeCreateDialog] Creating worktree with:', {
      projectId,
      projectPath,
      branchName: trimmedBranch,
      gitignoreSelections: Array.from(selectedPatterns)
    })

    setIsCreating(true)
    setError(null)
    setBranchError(null)

    try {
      const result = await window.api.worktree.create({
        projectId,
        projectPath,
        branchName: trimmedBranch,
        gitignoreSelections: Array.from(selectedPatterns)
      })

      console.log('[WorktreeCreateDialog] IPC result:', result)

      // Check if component is still mounted before updating state
      if (!isMountedRef.current) return

      if (!result.success) {
        setError(result.error ?? 'Failed to create worktree')
        setIsCreating(false)
        return
      }

      // Type guard: ensure result.data exists before accessing .id
      if (!result.data) {
        setError('Worktree created but no data returned')
        setIsCreating(false)
        return
      }

      // Success - call callback and close
      onSuccess?.(result.data.id)
      onClose()
    } catch (err) {
      console.error('[WorktreeCreateDialog] Exception during create:', err)
      if (!isMountedRef.current) return
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
      setIsCreating(false)
    }
  }, [branchName, selectedPatterns, projectId, projectPath, isCreating, onSuccess, onClose])

  const isFormValid = branchName.trim().length > 0 && !isCreating && !branchError

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
          onClick={isCreating ? undefined : onClose}
          role="presentation"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl max-w-[480px] w-full mx-4 border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="worktree-dialog-title"
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/50">
              <div className="flex items-center gap-2">
                <GitBranch size={14} className="text-muted-foreground" aria-hidden="true" />
                <h3 id="worktree-dialog-title" className="text-sm font-semibold text-foreground">
                  Create Worktree{projectName ? ` - ${projectName}` : ''}
                </h3>
              </div>
              <button
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground transition-colors"
                disabled={isCreating}
                aria-label="Close dialog"
              >
                <X size={14} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              {/* Error Display */}
              {error && (
                <div className="bg-destructive/10 border border-destructive/20 rounded px-3 py-2 text-xs text-destructive" role="alert">
                  {error}
                </div>
              )}

              {/* Branch Name Input */}
              <div>
                <label htmlFor="branch-name-input" className="block text-xs font-medium text-muted-foreground mb-1">
                  Branch Name
                </label>
                <input
                  id="branch-name-input"
                  type="text"
                  value={branchName}
                  onChange={(e) => {
                    setBranchName(e.target.value)
                    setBranchError(null) // Clear error on change
                  }}
                  placeholder="feature/auth"
                  disabled={isCreating}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && isFormValid) {
                      e.preventDefault()
                      handleCreate()
                    }
                  }}
                  aria-invalid={!!branchError}
                  aria-describedby={branchError ? 'branch-name-error' : 'branch-name-helper'}
                  className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none placeholder-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                  autoFocus
                />
                {branchError ? (
                  <p id="branch-name-error" className="text-xs text-destructive mt-1" role="alert">
                    {branchError}
                  </p>
                ) : (
                  <p id="branch-name-helper" className="text-xs text-muted-foreground mt-1">
                    Enter an existing branch name or create a new one
                  </p>
                )}
              </div>

              {/* .gitignore Patterns */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs font-medium text-muted-foreground">
                    .gitignore Patterns to Copy
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={selectAllPatterns}
                      disabled={isCreating}
                      className="text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={deselectAllPatterns}
                      disabled={isCreating}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      Deselect All
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5" role="group" aria-label="Gitignore patterns">
                  {GITIGNORE_PATTERNS.map((item) => {
                    const isSelected = selectedPatterns.has(item.pattern)
                    return (
                      <label
                        key={item.pattern}
                        className={cn(
                          'flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors',
                          isSelected ? 'bg-secondary/70' : 'hover:bg-secondary/30',
                          isCreating && 'opacity-50 cursor-not-allowed'
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => togglePattern(item.pattern)}
                          disabled={isCreating}
                          className="mt-0.5 rounded border-border"
                        />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm text-foreground">{item.label}</span>
                          {item.warning && (
                            <span className="block text-xs text-destructive mt-0.5">
                              ⚠️ {item.warning} - recommended: NO
                            </span>
                          )}
                        </div>
                      </label>
                    )
                  })}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
              <button
                onClick={onClose}
                disabled={isCreating}
                className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!isFormValid}
                className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 shadow-md shadow-primary/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {isCreating ? (
                  <>
                    <span className="animate-spin" aria-hidden="true">⟳</span>
                    Creating...
                  </>
                ) : (
                  <>
                    <Check size={12} aria-hidden="true" />
                    Create
                  </>
                )}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
