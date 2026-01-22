import { useState, useEffect, useCallback, useMemo } from 'react'
import { GitBranch, X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem
} from '@/components/ui/command'
import { useWorktrees, useWorktreeStatus } from '@/stores/worktree-store'
import { useWorktreeStore } from '@/stores/worktree-store'
import { cn } from '@/lib/utils'
import type { WorktreeMetadata, WorktreeStatus } from '@/src/features/worktrees/worktree.types'

interface WorktreeSelectorPaletteProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (worktreeId: string | string[]) => void
  title?: string
  allowMultiple?: boolean
  projectId?: string
}

interface WorktreeItemProps {
  worktree: WorktreeMetadata
  isSelected: boolean
  onToggle: (worktreeId: string) => void
}

function WorktreeStatusBadge({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const status = useWorktreeStatus(worktreeId)

  if (!status) return null

  const badges: React.JSX.Element[] = []

  if (status.dirty) {
    badges.push(
      <span
        key="dirty"
        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-500/10 text-yellow-500 border border-yellow-500/20"
      >
        Dirty
      </span>
    )
  }

  if (status.ahead > 0) {
    badges.push(
      <span
        key="ahead"
        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/10 text-blue-500 border border-blue-500/20"
      >
        ↑{status.ahead}
      </span>
    )
  }

  if (status.behind > 0) {
    badges.push(
      <span
        key="behind"
        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-500/10 text-purple-500 border border-purple-500/20"
      >
        ↓{status.behind}
      </span>
    )
  }

  if (status.conflicted) {
    badges.push(
      <span
        key="conflicted"
        className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-500 border border-red-500/20"
      >
        Conflicted
      </span>
    )
  }

  if (badges.length === 0) {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-500/10 text-green-500 border border-green-500/20">
        Clean
      </span>
    )
  }

  return <div className="flex gap-1">{badges}</div>
}

function WorktreeItem({ worktree, isSelected, onToggle }: WorktreeItemProps): React.JSX.Element {
  return (
    <CommandItem
      key={worktree.id}
      value={`${worktree.branchName} ${worktree.id}`}
      onSelect={() => onToggle(worktree.id)}
      className={cn(
        'flex items-center justify-between px-4 py-3 cursor-pointer',
        isSelected && 'bg-secondary'
      )}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <GitBranch size={14} className="text-muted-foreground flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground truncate">{worktree.branchName}</div>
          <div className="text-xs text-muted-foreground truncate">{worktree.worktreePath}</div>
        </div>
      </div>
      <WorktreeStatusBadge worktreeId={worktree.id} />
    </CommandItem>
  )
}

export function WorktreeSelectorPalette({
  isOpen,
  onClose,
  onSelect,
  title = 'Select Worktree',
  allowMultiple = false,
  projectId
}: WorktreeSelectorPaletteProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const allWorktrees = useWorktrees(projectId)
  
  // Get the status cache from the store
  const statusCache = useWorktreeStore((state) => state.statusCache)

  // Helper function to check if a worktree matches a status keyword
  const matchesStatusKeyword = useCallback(
    (worktree: WorktreeMetadata, keyword: string): boolean => {
      const status = statusCache.get(worktree.id)

      // If no status available, don't match any status keyword (including 'clean')
      // Users searching for 'clean' expect worktrees with known clean status
      if (!status) {
        return false
      }

      switch (keyword) {
        case 'dirty':
          return status.dirty
        case 'ahead':
          return status.ahead > 0
        case 'behind':
          return status.behind > 0
        case 'conflicted':
          return status.conflicted
        case 'clean':
          return !status.dirty && status.ahead === 0 && status.behind === 0 && !status.conflicted
        default:
          return false
      }
    },
    [statusCache]
  )

  // Filter worktrees by query (fuzzy search on branch name + status keyword filtering)
  const filteredWorktrees = useMemo(() => {
    if (!query.trim()) return allWorktrees

    const lowerQuery = query.toLowerCase()
    const tokens = lowerQuery.split(/\s+/).filter(Boolean)

    // Separate status keywords from search tokens
    const statusKeywords = tokens.filter((token) =>
      ['dirty', 'ahead', 'behind', 'conflicted', 'clean'].includes(token)
    )
    const searchTokens = tokens.filter(
      (token) => !['dirty', 'ahead', 'behind', 'conflicted', 'clean'].includes(token)
    )

    return allWorktrees.filter((worktree) => {
      const searchText = `${worktree.branchName} ${worktree.id}`.toLowerCase()

      // Apply search token filtering (fuzzy match on branch name)
      if (searchTokens.length > 0) {
        const matchesSearch = searchTokens.every((token) => searchText.includes(token))
        if (!matchesSearch) return false
      }

      // Apply status keyword filtering if any status keywords are present
      if (statusKeywords.length > 0) {
        return statusKeywords.some((keyword) => matchesStatusKeyword(worktree, keyword))
      }

      return true
    })
  }, [allWorktrees, query, matchesStatusKeyword])

  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIds(new Set())
    }
  }, [isOpen])

  const handleToggle = useCallback(
    (worktreeId: string) => {
      if (allowMultiple) {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(worktreeId)) {
            next.delete(worktreeId)
          } else {
            next.add(worktreeId)
          }
          return next
        })
      } else {
        // Single select - immediately select and close
        onSelect(worktreeId)
        onClose()
      }
    },
    [allowMultiple, onSelect, onClose]
  )

  const handleConfirm = useCallback(() => {
    if (allowMultiple && selectedIds.size > 0) {
      // Pass all selected IDs as an array for bulk operations
      const idsArray = Array.from(selectedIds)
      onSelect(idsArray)
      onClose()
    }
  }, [allowMultiple, selectedIds, onSelect, onClose])

  // Handle Escape key
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [isOpen, onClose])

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[70] flex flex-col items-center pt-[10vh] bg-black/40 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{ duration: 0.15 }}
            className="w-full max-w-2xl bg-card rounded-xl shadow-2xl border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-secondary/50">
              <h3 className="text-sm font-semibold text-foreground">{title}</h3>
              <button
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </div>

            <Command className="[&_[cmdk-group-heading]]:text-muted-foreground" shouldFilter={false}>
              <CommandInput
                placeholder="Search worktrees..."
                value={query}
                onValueChange={setQuery}
                className="text-lg"
              />
              <CommandList className="max-h-[60vh]">
                <CommandEmpty>No worktrees found.</CommandEmpty>

                <CommandGroup>
                  {filteredWorktrees.map((worktree) => (
                    <WorktreeItem
                      key={worktree.id}
                      worktree={worktree}
                      isSelected={selectedIds.has(worktree.id)}
                      onToggle={handleToggle}
                    />
                  ))}
                </CommandGroup>
              </CommandList>

              {/* Footer */}
              <div className="bg-background px-4 py-2 border-t border-border flex items-center justify-end space-x-4 text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                {allowMultiple && (
                  <button
                    onClick={handleConfirm}
                    disabled={selectedIds.size === 0}
                    className="text-primary hover:text-primary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Confirm ({selectedIds.size})
                  </button>
                )}
                <span className="flex items-center">
                  <kbd className="bg-secondary text-foreground px-1 rounded mr-1">↑↓</kbd> to navigate
                </span>
                <span className="flex items-center">
                  <kbd className="bg-secondary text-foreground px-1 rounded mr-1">↵</kbd> to select
                </span>
                <span className="flex items-center">
                  <kbd className="bg-secondary text-foreground px-1 rounded mr-1">Esc</kbd> to close
                </span>
              </div>
            </Command>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
