/**
 * QuickHotfixDialog Component
 *
 * Minimal dialog for creating a hotfix worktree in Emergency Mode.
 * Skips optional prompts and uses safe defaults.
 * Source: Story 3.5 - Emergency Mode
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { GitBranch, X, Check, AlertTriangle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

// Generate hotfix branch name with timestamp
function generateHotfixName(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  const hours = String(now.getHours()).padStart(2, '0')
  const minutes = String(now.getMinutes()).padStart(2, '0')
  const seconds = String(now.getSeconds()).padStart(2, '0')

  return `hotfix/critical-bug-${year}${month}${day}-${hours}${minutes}${seconds}`
}

// Git branch name validation rules
const INVALID_BRANCH_CHARS = /[\.\.~^:\\\?\*\[\s]|^\/|\/$|\/\//
const RESERVED_BRANCH_NAMES = ['HEAD', '@']

function isValidBranchName(name: string): boolean {
  const trimmed = name.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length > 256) return false
  if (RESERVED_BRANCH_NAMES.includes(trimmed)) return false
  if (INVALID_BRANCH_CHARS.test(trimmed)) return false
  return true
}

// Default .gitignore patterns for hotfix (security-first)
const HOTFIX_GITIGNORE_PATTERNS = ['node_modules/', '.env', 'dist/', 'build/']

export interface QuickHotfixDialogProps {
  isOpen: boolean
  projectId: string
  projectName?: string
  projectPath: string
  onClose: () => void
  onSuccess?: (worktreeId: string) => void
  onCreatingChange?: (isCreating: boolean) => void
}

export function QuickHotfixDialog({
  isOpen,
  projectId,
  projectName,
  projectPath,
  onClose,
  onSuccess,
  onCreatingChange
}: QuickHotfixDialogProps): React.JSX.Element {
  const [branchName, setBranchName] = useState(generateHotfixName())
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [branchError, setBranchError] = useState<string | null>(null)

  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Regenerate timestamp when modal opens
  useEffect(() => {
    if (isOpen) {
      setBranchName(generateHotfixName())
      setIsCreating(false)
      setError(null)
      setBranchError(null)
    }
  }, [isOpen])

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

  useEffect(() => {
    onCreatingChange?.(isCreating)
  }, [isCreating, onCreatingChange])

  const handleCreate = useCallback(async () => {
    const trimmedBranch = branchName.trim()
    if (!trimmedBranch || isCreating) return

    if (!projectPath) {
      setError('Project path is required to create a worktree')
      return
    }

    if (!isValidBranchName(trimmedBranch)) {
      setBranchError('Invalid branch name. Cannot contain: .., ~, ^, :, \\, ?, *, spaces, or start/end with /')
      return
    }

    console.log('[QuickHotfixDialog] Creating hotfix worktree with:', {
      projectId,
      projectPath,
      branchName: trimmedBranch,
      gitignoreSelections: HOTFIX_GITIGNORE_PATTERNS
    })

    setIsCreating(true)
    setError(null)
    setBranchError(null)

    try {
      const result = await window.api.worktree.create({
        projectId,
        projectPath,
        branchName: trimmedBranch,
        gitignoreSelections: HOTFIX_GITIGNORE_PATTERNS
      })

      console.log('[QuickHotfixDialog] IPC result:', result)

      if (!isMountedRef.current) return

      if (!result.success) {
        setError(result.error ?? 'Failed to create hotfix worktree')
        setIsCreating(false)
        return
      }

      if (!result.data) {
        setError('Hotfix worktree created but no data returned')
        setIsCreating(false)
        return
      }

      setIsCreating(false)
      onSuccess?.(result.data.id)
      onClose()
    } catch (err) {
      console.error('[QuickHotfixDialog] Exception during create:', err)
      if (!isMountedRef.current) return
      setError(err instanceof Error ? err.message : 'An unexpected error occurred')
      setIsCreating(false)
    }
  }, [branchName, projectId, projectPath, isCreating, onSuccess, onClose])

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
            aria-labelledby="hotfix-dialog-title"
          >
            {/* Header with Emergency Mode indicator */}
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-destructive/10">
              <div className="flex items-center gap-2">
                <AlertTriangle size={14} className="text-destructive" aria-hidden="true" />
                <h3 id="hotfix-dialog-title" className="text-sm font-semibold text-foreground">
                  Emergency Hotfix{projectName ? ` - ${projectName}` : ''}
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
              {/* Emergency Mode Badge */}
              <div className="flex items-center gap-2 px-3 py-2 bg-destructive/10 border border-destructive/20 rounded">
                <AlertTriangle size={14} className="text-destructive" />
                <span className="text-xs font-medium text-destructive">
                  Emergency Mode active - using safe defaults
                </span>
              </div>

              {/* Error Display */}
              {error && (
                <div className="bg-destructive/10 border border-destructive/20 rounded px-3 py-2 text-xs text-destructive" role="alert">
                  {error}
                </div>
              )}

              {/* Branch Name Input */}
              <div>
                <label htmlFor="hotfix-branch-input" className="block text-xs font-medium text-muted-foreground mb-1">
                  Hotfix Branch Name
                </label>
                <input
                  id="hotfix-branch-input"
                  type="text"
                  value={branchName}
                  onChange={(e) => {
                    setBranchName(e.target.value)
                    setBranchError(null)
                  }}
                  placeholder="hotfix/critical-bug-20250116-143022"
                  disabled={isCreating}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && isFormValid) {
                      e.preventDefault()
                      handleCreate()
                    }
                  }}
                  aria-invalid={!!branchError}
                  aria-describedby={branchError ? 'hotfix-branch-error' : 'hotfix-branch-helper'}
                  className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none placeholder-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed font-mono"
                  autoFocus
                />
                {branchError ? (
                  <p id="hotfix-branch-error" className="text-xs text-destructive mt-1" role="alert">
                    {branchError}
                  </p>
                ) : (
                  <p id="hotfix-branch-helper" className="text-xs text-muted-foreground mt-1">
                    Auto-generated with timestamp. Edit if needed.
                  </p>
                )}
              </div>

              {/* Safe Defaults Info */}
              <div className="px-3 py-2 bg-secondary/50 rounded border border-border">
                <p className="text-xs font-medium text-foreground mb-1">Safe defaults applied:</p>
                <ul className="text-xs text-muted-foreground space-y-0.5">
                  <li>• Base branch: main (or master if main not found)</li>
                  <li>• .gitignore: node_modules/, .env, dist/, build/</li>
                  <li>• Location: default worktree directory</li>
                </ul>
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
                className="px-3 py-1.5 text-xs font-medium bg-destructive text-destructive-foreground rounded hover:bg-destructive/90 shadow-md shadow-destructive/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {isCreating ? (
                  <>
                    <span className="animate-spin" aria-hidden="true">⟳</span>
                    Creating...
                  </>
                ) : (
                  <>
                    <Check size={12} aria-hidden="true" />
                    Create Hotfix
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
