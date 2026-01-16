/**
 * WorktreeProjectSection Component
 *
 * Displays a collapsible worktree section under each project in the sidebar.
 * Integrates with ProjectSidebar to show worktrees with expand/collapse functionality.
 * Source: Story 1.5 - Task 4: Extend ProjectSidebar for Worktrees
 * Story 1.6: Archive/Delete dialogs integration
 * Story 1.6 - Task 3: Search and Filter integration
 */

import { memo, useState, useCallback, useMemo } from 'react'
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { WorktreeList } from './WorktreeList'
import { WorktreeContextMenu } from './WorktreeContextMenu'
import { WorktreeArchiveDialog } from './WorktreeArchiveDialog'
import { WorktreeDeleteDialog } from './WorktreeDeleteDialog'
import { WorktreeSearchBar } from './WorktreeSearchBar'
import { WorktreeFilterBar, type WorktreeStatusFilter } from './WorktreeFilterBar'
import { useWorktrees, useWorktreeCount, useProjectExpanded, useSelectedWorktreeId, useWorktreeActions } from '@/stores/worktree-store'
import type { WorktreeMetadata } from '../../worktree.types'

/**
 * Check if branch is main/master (requires extra confirmation)
 */
function isMainBranch(branchName: string): boolean {
  const mainBranches = ['main', 'master', 'develop', 'development']
  return mainBranches.includes(branchName.toLowerCase())
}

export interface WorktreeProjectSectionProps {
  projectId: string
  onWorktreeSelect?: (worktreeId: string) => void
}

/**
 * WorktreeCountBadge - Shows count of worktrees for a project
 */
interface WorktreeCountBadgeProps {
  count: number
  className?: string
}

function WorktreeCountBadge({ count, className }: WorktreeCountBadgeProps) {
  if (count === 0) return null

  return (
    <span
      className={cn(
        'ml-auto flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full',
        'text-xs font-medium bg-primary/10 text-primary',
        className
      )}
      aria-label={`${count} worktree${count !== 1 ? 's' : ''}`}
    >
      {count}
    </span>
  )
}

/**
 * WorktreeProjectSection - Collapsible section showing worktrees for a project
 */
export const WorktreeProjectSection = memo(({ projectId, onWorktreeSelect }: WorktreeProjectSectionProps) => {
  const worktrees = useWorktrees(projectId)
  const worktreeCount = useWorktreeCount(projectId)
  const isExpanded = useProjectExpanded(projectId)
  const selectedWorktreeId = useSelectedWorktreeId()
  const { setSelectedWorktree, toggleProjectExpanded } = useWorktreeActions()
  const isLoading = false // Could add loading state from store if needed

  // Context menu state
  const [contextMenuState, setContextMenuState] = useState<{
    isOpen: boolean
    worktree: WorktreeMetadata | null
    x: number
    y: number
  }>({
    isOpen: false,
    worktree: null,
    x: 0,
    y: 0
  })

  // Dialog states
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [selectedWorktreeForDialog, setSelectedWorktreeForDialog] = useState<WorktreeMetadata | null>(null)

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<WorktreeStatusFilter>('all')
  const [isBulkSelectMode, setIsBulkSelectMode] = useState(false)
  const [selectedWorktrees, setSelectedWorktrees] = useState<Set<string>>(new Set())

  // Filter out archived worktrees
  const activeWorktrees = useMemo(() => {
    return worktrees.filter((w) => !w.isArchived)
  }, [worktrees])

  // Apply search and status filters
  const filteredWorktrees = useMemo(() => {
    let filtered = activeWorktrees

    // Apply search filter
    if (searchQuery) {
      const lowerQuery = searchQuery.toLowerCase()
      filtered = filtered.filter(w =>
        w.branchName.toLowerCase().includes(lowerQuery)
      )
    }

    // Apply status filter
    if (statusFilter !== 'all') {
      filtered = filtered.filter(w => {
        const status = w.status
        switch (statusFilter) {
          case 'dirty':
            return status?.dirty ?? false
          case 'ahead':
            return (status?.ahead ?? 0) > 0
          case 'behind':
            return (status?.behind ?? 0) > 0
          case 'conflicted':
            return status?.conflicted ?? false
          default:
            return true
        }
      })
    }

    return filtered
  }, [activeWorktrees, searchQuery, statusFilter])

  const hasWorktrees = activeWorktrees.length > 0

  // Debug logging
  console.log('[WorktreeProjectSection] projectId:', projectId, 'worktrees:', worktrees.length, 'activeWorktrees:', activeWorktrees.length, 'hasWorktrees:', hasWorktrees)

  const handleToggleExpanded = () => {
    toggleProjectExpanded(projectId)
  }

  const handleWorktreeSelect = (worktreeId: string) => {
    setSelectedWorktree(worktreeId)
    onWorktreeSelect?.(worktreeId)
  }

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent, worktree: WorktreeMetadata) => {
    console.log('[WorktreeProjectSection] Context menu triggered for worktree:', worktree.branchName)
    e.preventDefault()
    e.stopPropagation()
    setContextMenuState({
      isOpen: true,
      worktree,
      x: e.clientX,
      y: e.clientY
    })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenuState(prev => ({ ...prev, isOpen: false }))
  }, [])

  const handleOpenTerminal = useCallback((worktreeId: string) => {
    // TODO: Implement terminal opening via IPC
    console.log('Open terminal for worktree:', worktreeId)
  }, [])

  const handleArchive = useCallback((worktreeId: string) => {
    // Open archive dialog for confirmation
    const worktree = worktrees.find(w => w.id === worktreeId)
    if (worktree) {
      setSelectedWorktreeForDialog(worktree)
      setArchiveDialogOpen(true)
    }
  }, [worktrees])

  const handleDelete = useCallback((worktreeId: string) => {
    // Open delete dialog for confirmation
    const worktree = worktrees.find(w => w.id === worktreeId)
    if (worktree) {
      setSelectedWorktreeForDialog(worktree)
      setDeleteDialogOpen(true)
    }
  }, [worktrees])

  const handleShowInExplorer = useCallback((worktreeId: string) => {
    // TODO: Implement show in explorer via IPC
    console.log('Show in explorer:', worktreeId)
  }, [])

  // Dialog handlers
  const handleArchiveConfirm = useCallback(async () => {
    if (!selectedWorktreeForDialog) return

    console.log('[WorktreeProjectSection] Archiving worktree:', selectedWorktreeForDialog.id)

    // Call IPC to archive worktree
    try {
      const result = await window.api.worktree.archive(selectedWorktreeForDialog.id)

      if (result.success) {
        console.log('[WorktreeProjectSection] Archive successful:', result.data)
        // TODO: Update store to remove worktree from active list
        // TODO: Add to archived worktrees list
      } else {
        console.error('[WorktreeProjectSection] Archive failed:', result.error)
        // TODO: Show error toast
      }
    } catch (error) {
      console.error('[WorktreeProjectSection] Archive error:', error)
    }

    setArchiveDialogOpen(false)
    setSelectedWorktreeForDialog(null)
  }, [selectedWorktreeForDialog])

  const handleArchiveCancel = useCallback(() => {
    setArchiveDialogOpen(false)
    setSelectedWorktreeForDialog(null)
  }, [])

  const handleDeleteConfirm = useCallback(async (options: { deleteBranch?: boolean }) => {
    if (!selectedWorktreeForDialog) return

    console.log('[WorktreeProjectSection] Deleting worktree:', selectedWorktreeForDialog.id, 'options:', options)

    // Call IPC to delete worktree
    try {
      const result = await window.api.worktree.delete(selectedWorktreeForDialog.id, options)

      if (result.success) {
        console.log('[WorktreeProjectSection] Delete successful')
        // TODO: Update store to remove worktree from active list
      } else {
        console.error('[WorktreeProjectSection] Delete failed:', result.error)
        // TODO: Show error toast
      }
    } catch (error) {
      console.error('[WorktreeProjectSection] Delete error:', error)
    }

    setDeleteDialogOpen(false)
    setSelectedWorktreeForDialog(null)
  }, [selectedWorktreeForDialog])

  const handleDeleteCancel = useCallback(() => {
    setDeleteDialogOpen(false)
    setSelectedWorktreeForDialog(null)
  }, [])

  // Bulk selection handlers
  const handleToggleBulkSelect = useCallback(() => {
    setIsBulkSelectMode(prev => !prev)
    setSelectedWorktrees(new Set())
  }, [])

  const handleToggleWorktreeSelection = useCallback((worktreeId: string) => {
    setSelectedWorktrees(prev => {
      const newSet = new Set(prev)
      if (newSet.has(worktreeId)) {
        newSet.delete(worktreeId)
      } else {
        newSet.add(worktreeId)
      }
      return newSet
    })
  }, [])

  const handleBulkArchive = useCallback(async () => {
    console.log('[WorktreeProjectSection] Bulk archive:', Array.from(selectedWorktrees))
    // TODO: Implement bulk archive via IPC
    setIsBulkSelectMode(false)
    setSelectedWorktrees(new Set())
  }, [selectedWorktrees])

  const handleBulkDelete = useCallback(async () => {
    console.log('[WorktreeProjectSection] Bulk delete:', Array.from(selectedWorktrees))
    // TODO: Implement bulk delete via IPC
    setIsBulkSelectMode(false)
    setSelectedWorktrees(new Set())
  }, [selectedWorktrees])

  // Don't render if no worktrees
  if (!hasWorktrees) {
    return null
  }

  return (
    <div className="worktree-section">
      {/* Header with expand/collapse toggle */}
      <button
        type="button"
        onClick={handleToggleExpanded}
        className={cn(
          'w-full flex items-center px-4 py-1.5 text-left transition-colors',
          'hover:bg-secondary/50 text-muted-foreground hover:text-foreground'
        )}
        aria-expanded={isExpanded}
        aria-label={`Worktrees for project (${activeWorktrees.length})`}
      >
        <span className="flex-shrink-0 mr-1">
          {isExpanded ? (
            <ChevronDown size={14} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" />
          )}
        </span>
        <span className="text-xs font-medium">Worktrees</span>
        {isLoading && (
          <Loader2 size={12} className="ml-2 animate-spin text-muted-foreground" />
        )}
        <WorktreeCountBadge count={activeWorktrees.length} />
      </button>

      {/* Collapsible worktree list */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: { duration: 0.2, ease: 'easeInOut' },
              opacity: { duration: 0.15 }
            }}
            className="overflow-hidden"
          >
            {/* Search Bar (appears when >= 10 worktrees) */}
            <WorktreeSearchBar
              value={searchQuery}
              onChange={setSearchQuery}
              count={activeWorktrees.length}
              threshold={10}
            />

            {/* Filter Bar */}
            <WorktreeFilterBar
              filter={statusFilter}
              onFilterChange={setStatusFilter}
              selectedCount={selectedWorktrees.size}
              onBulkSelect={handleToggleBulkSelect}
              isBulkSelectMode={isBulkSelectMode}
              onBulkArchive={handleBulkArchive}
              onBulkDelete={handleBulkDelete}
            />

            {/* Worktree List */}
            <div className="pl-4 pr-2 py-1">
              <WorktreeList
                worktrees={filteredWorktrees}
                selectedWorktreeId={selectedWorktreeId}
                onWorktreeSelect={handleWorktreeSelect}
                isLoading={isLoading}
                isEmpty={filteredWorktrees.length === 0}
                onWorktreeContextMenu={handleContextMenu}
                isBulkSelectMode={isBulkSelectMode}
                selectedWorktrees={selectedWorktrees}
                onToggleSelection={handleToggleWorktreeSelection}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Context menu */}
      {contextMenuState.isOpen && contextMenuState.worktree && (
        <WorktreeContextMenu
          worktree={contextMenuState.worktree}
          isOpen={contextMenuState.isOpen}
          x={contextMenuState.x}
          y={contextMenuState.y}
          onClose={closeContextMenu}
          onOpenTerminal={handleOpenTerminal}
          onArchive={handleArchive}
          onDelete={handleDelete}
          onShowInExplorer={handleShowInExplorer}
        />
      )}

      {/* Archive Dialog */}
      <WorktreeArchiveDialog
        isOpen={archiveDialogOpen}
        worktree={selectedWorktreeForDialog}
        onConfirm={handleArchiveConfirm}
        onCancel={handleArchiveCancel}
      />

      {/* Delete Dialog */}
      <WorktreeDeleteDialog
        isOpen={deleteDialogOpen}
        worktree={selectedWorktreeForDialog}
        hasUnpushedCommits={false} // TODO: Check via IPC
        unpushedCommitCount={0}
        isMainBranch={selectedWorktreeForDialog ? isMainBranch(selectedWorktreeForDialog.branchName) : false}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </div>
  )
})

WorktreeProjectSection.displayName = 'WorktreeProjectSection'
