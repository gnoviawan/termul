/**
 * WorktreeProjectSection Component
 *
 * Displays a collapsible worktree section under each project in the sidebar.
 * Integrates with ProjectSidebar to show worktrees with expand/collapse functionality.
 * Source: Story 1.5 - Task 4: Extend ProjectSidebar for Worktrees
 * Story 1.6: Archive/Delete dialogs integration
 * Story 1.6 - Task 3: Search and Filter integration
 */

import { memo, useState, useCallback, useMemo, useEffect } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { WorktreeList } from './WorktreeList'
import { WorktreeContextMenu } from './WorktreeContextMenu'
import { WorktreeArchiveDialog } from './WorktreeArchiveDialog'
import { WorktreeDeleteDialog } from './WorktreeDeleteDialog'
import { WorktreeSearchBar } from './WorktreeSearchBar'
import { WorktreeFilterBar, type WorktreeStatusFilter } from './WorktreeFilterBar'
import {
  useWorktrees,
  useWorktreeCount,
  useProjectExpanded,
  useSelectedWorktreeId,
  useWorktreeActions,
  useWorktreeStore
} from '@/stores/worktree-store'
import type { WorktreeMetadata } from '../worktree.types'
import { MergeWorkflowManager, SyncWorkflowManager } from '../../merge/components'


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
  onOpenTerminal?: (worktreeId: string, worktreePath: string, branchName: string) => void
  onCreateWorktree?: (projectId: string) => void
  onDialogStateChange?: (isOpen: boolean) => void
}

/**
 * WorktreeProjectSection - Collapsible section showing worktrees for a project
 */
export const WorktreeProjectSection = memo(({ projectId, onWorktreeSelect, onOpenTerminal, onCreateWorktree, onDialogStateChange }: WorktreeProjectSectionProps) => {
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

  // Merge workflow states (Story 2.4)
  const [mergeWorkflowOpen, setMergeWorkflowOpen] = useState(false)
  const [mergeWorktree, setMergeWorktree] = useState<WorktreeMetadata | null>(null)

  // Sync workflow states (Story 2.5)
  const [syncWorkflowOpen, setSyncWorkflowOpen] = useState(false)
  const [syncWorktree, setSyncWorktree] = useState<WorktreeMetadata | null>(null)

  // Search and filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<WorktreeStatusFilter>('all')

  const statusCache = useWorktreeStore((state) => state.statusCache)

  // Notify parent when any dialog is open (to disable drag on parent Reorder.Item)
  useEffect(() => {
    const hasOpenDialog =
      contextMenuState.isOpen ||
      archiveDialogOpen ||
      deleteDialogOpen ||
      mergeWorkflowOpen ||
      syncWorkflowOpen
    onDialogStateChange?.(hasOpenDialog)
  }, [contextMenuState.isOpen, archiveDialogOpen, deleteDialogOpen, mergeWorkflowOpen, syncWorkflowOpen, onDialogStateChange])

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
        const status = statusCache.get(w.id)
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
  }, [activeWorktrees, searchQuery, statusCache, statusFilter])


  const hasWorktrees = activeWorktrees.length > 0

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

  // Merge to main handler (Story 2.4)
  const handleMergeToMain = useCallback((worktreeId: string) => {
    const worktree = worktrees.find(w => w.id === worktreeId)
    if (worktree) {
      setMergeWorktree(worktree)
      setMergeWorkflowOpen(true)
    }
  }, [worktrees])

  // Sync upstream handler (Story 2.5)
  const handleSyncUpstream = useCallback((worktreeId: string) => {
    const worktree = worktrees.find(w => w.id === worktreeId)
    if (worktree) {
      setSyncWorktree(worktree)
      setSyncWorkflowOpen(true)
    }
  }, [worktrees])

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

  // Don't render if no worktrees
  if (!hasWorktrees) {
    return null
  }

  return (
    <div className="worktree-section">
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
                onOpenTerminal={onOpenTerminal}
              />

              {/* + Worktree button - full width with background matching worktree items */}
              {onCreateWorktree && (
                <button
                  type="button"
                  onClick={() => onCreateWorktree(projectId)}
                  className="w-full flex items-center gap-1 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors rounded-md mt-1"
                  aria-label="Create new worktree"
                >
                  <Plus size={14} aria-hidden="true" />
                  <span>worktree</span>
                </button>
              )}
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
          onMergeToMain={handleMergeToMain}
          onSyncUpstream={handleSyncUpstream}
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

      {/* Merge Workflow Dialog (Story 2.4) */}
      {mergeWorktree && (
        <MergeWorkflowManager
          isOpen={mergeWorkflowOpen}
          worktreeId={mergeWorktree.id}
          sourceBranch={mergeWorktree.branchName}
          projectId={projectId}
          onCancel={() => setMergeWorkflowOpen(false)}
          onComplete={() => setMergeWorkflowOpen(false)}
        />
      )}


      {/* Sync Workflow Dialog (Story 2.5) */}
      {syncWorktree && (
        <SyncWorkflowManager
          isOpen={syncWorkflowOpen}
          worktreeId={syncWorktree.id}
          featureBranch={syncWorktree.branchName}
          projectId={projectId}
          onCancel={() => setSyncWorkflowOpen(false)}
          onComplete={() => setSyncWorkflowOpen(false)}
        />
      )}
    </div>
  )
})

WorktreeProjectSection.displayName = 'WorktreeProjectSection'
