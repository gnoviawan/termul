/**
 * WorktreeCreateDialog Component
 *
 * Modal dialog for creating a new Git worktree from the project sidebar.
 * Allows users to specify branch name and .gitignore patterns to copy.
 * Source: Story 1.4 - Add Create Worktree to Project Context Menu
 * Tech-Spec: Dynamic .gitignore Pattern Selection for Worktree Creation
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { GitBranch, X, Check, AlertTriangle, Search, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { ParsedPattern } from '@shared/types/ipc.types'

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

  // Dynamic pattern loading state
  const [availablePatterns, setAvailablePatterns] = useState<ParsedPattern[]>([])
  const [isLoadingPatterns, setIsLoadingPatterns] = useState(false)
  const [patternLoadError, setPatternLoadError] = useState<string | null>(null)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')

  // Track mounted state to prevent memory leak
  const isMountedRef = useRef(true)

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  // Load patterns from .gitignore when dialog opens
  useEffect(() => {
    if (!isOpen) {
      // Reset state when dialog closes
      setAvailablePatterns([])
      setPatternLoadError(null)
      setSearchQuery('')
      return
    }

    const loadPatterns = async (): Promise<void> => {
      setIsLoadingPatterns(true)
      setPatternLoadError(null)

      try {
        console.log('[WorktreeCreateDialog] Loading patterns from projectRoot:', projectPath)
        const result = await window.api.gitignore.parse({ projectRoot: projectPath })
        console.log('[WorktreeCreateDialog] IPC result:', result)

        if (!isMountedRef.current) return

        if (!result.success) {
          console.log('[WorktreeCreateDialog] IPC failed:', result.error, result.code)
          // Handle missing .gitignore gracefully
          if (result.code === 'GITIGNORE_PARSE_FAILED') {
            setPatternLoadError(null) // No error, just no patterns
            setAvailablePatterns([])
          } else {
            setPatternLoadError(result.error ?? 'Failed to load patterns')
          }
          setIsLoadingPatterns(false)
          return
        }

        // Extract patterns from response
        const patterns = result.data?.patterns ?? []
        console.log('[WorktreeCreateDialog] Parsed patterns:', patterns.length, patterns)
        setAvailablePatterns(patterns)

        // Initialize selected patterns (exclude security-sensitive patterns)
        const initialSelection = new Set(
          patterns
            .filter((p: ParsedPattern) => !p.isSecuritySensitive)
            .map((p: ParsedPattern) => p.pattern)
        )
        setSelectedPatterns(initialSelection)
      } catch (err) {
        if (!isMountedRef.current) return
        console.error('[WorktreeCreateDialog] Failed to load patterns:', err)
        // Treat errors as missing .gitignore - allow creation to proceed
        setPatternLoadError(null)
        setAvailablePatterns([])
      } finally {
        if (isMountedRef.current) {
          setIsLoadingPatterns(false)
        }
      }
    }

    loadPatterns()
  }, [isOpen, projectPath])

  // Reset form when modal opens - parent controls reset timing
  useEffect(() => {
    if (isOpen) {
      setBranchName('')
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

  // Debounced search with useMemo
  const filteredPatterns = useMemo(() => {
    if (!searchQuery.trim()) {
      return availablePatterns
    }

    const query = searchQuery.toLowerCase()
    return availablePatterns.filter((pattern) =>
      pattern.pattern.toLowerCase().includes(query) ||
      pattern.category.toLowerCase().includes(query)
    )
  }, [availablePatterns, searchQuery])

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
    setSelectedPatterns(new Set(filteredPatterns.map((p) => p.pattern)))
  }, [filteredPatterns])

  const deselectAllPatterns = useCallback((): void => {
    setSelectedPatterns(new Set())
  }, [])

  const handleCreate = useCallback(async () => {
    const trimmedBranch = branchName.trim()
    if (!trimmedBranch || isCreating) return

    if (!projectPath) {
      setError('Project path is required to create a worktree')
      return
    }

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
        // Check if error is from pattern validation
        if (result.error?.includes('Pattern validation failed')) {
          setError(result.error)
        } else {
          setError(result.error ?? 'Failed to create worktree')
        }
        setIsCreating(false)
        return
      }

      // Type guard: ensure result.data exists before accessing .id
      if (!result.data) {
        setError('Worktree created but no data returned')
        setIsCreating(false)
        return
      }

      // Success - reset state, call callback and close
      setIsCreating(false)
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

  const selectedCount = selectedPatterns.size
  const totalCount = availablePatterns.length
  const hasNoGitignore = !isLoadingPatterns && availablePatterns.length === 0 && !patternLoadError

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
            <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
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
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground">
                      .gitignore Patterns to Copy
                    </label>
                    {totalCount > 0 && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {totalCount} patterns from .gitignore · {selectedCount} selected
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={selectAllPatterns}
                      disabled={isCreating || isLoadingPatterns || filteredPatterns.length === 0}
                      className="text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={deselectAllPatterns}
                      disabled={isCreating || selectedCount === 0}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Deselect All
                    </button>
                  </div>
                </div>

                {/* Search Input */}
                {totalCount > 0 && (
                  <div className="relative mb-2">
                    <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search patterns..."
                      disabled={isCreating || isLoadingPatterns}
                      className="w-full bg-secondary border border-border rounded pl-8 pr-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none placeholder-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                  </div>
                )}

                {/* Loading State */}
                {isLoadingPatterns && (
                  <div className="flex items-center justify-center py-8 text-muted-foreground">
                    <Loader2 size={16} className="animate-spin mr-2" />
                    <span className="text-xs">Loading patterns from .gitignore...</span>
                  </div>
                )}

                {/* No .gitignore Message */}
                {hasNoGitignore && (
                  <div className="py-4 px-3 bg-muted/30 rounded text-center">
                    <p className="text-xs text-muted-foreground">
                      No .gitignore found. All files will be copied to the worktree.
                    </p>
                  </div>
                )}

                {/* Pattern Error */}
                {patternLoadError && (
                  <div className="py-4 px-3 bg-destructive/10 rounded text-center">
                    <p className="text-xs text-destructive">
                      Failed to load patterns: {patternLoadError}
                    </p>
                  </div>
                )}

                {/* Pattern List */}
                {!isLoadingPatterns && filteredPatterns.length > 0 && (
                  <div className="space-y-0.5 max-h-[200px] overflow-y-auto" role="group" aria-label="Gitignore patterns">
                    {filteredPatterns.map((pattern) => {
                      const isSelected = selectedPatterns.has(pattern.pattern)
                      return (
                        <div
                          key={pattern.pattern}
                          onClick={() => !isCreating && togglePattern(pattern.pattern)}
                          className={cn(
                            'flex items-center gap-2 px-2 py-2 rounded cursor-pointer transition-colors',
                            isSelected ? 'bg-primary/10' : 'hover:bg-secondary/30',
                            isCreating && 'opacity-50 cursor-not-allowed'
                          )}
                          role="button"
                          tabIndex={isCreating ? -1 : 0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              togglePattern(pattern.pattern)
                            }
                          }}
                          aria-pressed={isSelected}
                        >
                          <span className="flex-1 min-w-0 text-sm text-foreground truncate">
                            {pattern.pattern}
                          </span>
                          <span className="text-xs text-muted-foreground uppercase">
                            {pattern.category}
                          </span>
                          {pattern.isSecuritySensitive && (
                            <AlertTriangle
                              size={12}
                              className="text-destructive flex-shrink-0"
                              aria-label="Security-sensitive pattern"
                            />
                          )}
                          {isSelected && (
                            <Check
                              size={14}
                              className="text-primary flex-shrink-0"
                              aria-hidden="true"
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* No Search Results */}
                {!isLoadingPatterns && searchQuery && filteredPatterns.length === 0 && totalCount > 0 && (
                  <div className="py-4 text-center text-muted-foreground">
                    <p className="text-xs">No patterns match "{searchQuery}"</p>
                  </div>
                )}
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
                    <Loader2 size={12} className="animate-spin" aria-hidden="true" />
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
