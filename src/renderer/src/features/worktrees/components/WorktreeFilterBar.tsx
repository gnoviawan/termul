/**
 * WorktreeFilterBar Component
 *
 * Filter bar for filtering worktrees by status and bulk selection.
 * Source: Story 1.6 - Task 3.3: Create WorktreeFilterBar with status filters
 */

import { memo, useCallback } from 'react'
import { CheckCircle2, AlertCircle, AlertTriangle, GitMerge } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

export type WorktreeStatusFilter = 'all' | 'dirty' | 'ahead' | 'behind' | 'conflicted'

export interface WorktreeFilterBarProps {
  filter: WorktreeStatusFilter
  onFilterChange: (filter: WorktreeStatusFilter) => void
  selectedCount?: number
  onBulkSelect?: () => void
  isBulkSelectMode?: boolean
  onBulkArchive?: () => void
  onBulkDelete?: () => void
  className?: string
}

/**
 * Filter button configuration
 */
const FILTERS: Array<{
  value: WorktreeStatusFilter
  label: string
  icon: React.ComponentType<{ className?: string }>
  color: string
}> = [
  { value: 'all', label: 'All', icon: CheckCircle2, color: 'text-muted-foreground' },
  { value: 'dirty', label: 'Dirty', icon: AlertCircle, color: 'text-orange-500' },
  { value: 'ahead', label: 'Ahead', icon: GitMerge, color: 'text-blue-500' },
  { value: 'behind', label: 'Behind', icon: GitMerge, color: 'text-yellow-500' },
  { value: 'conflicted', label: 'Conflicts', icon: AlertTriangle, color: 'text-red-500' },
]

/**
 * WorktreeFilterBar - Status filter buttons and bulk actions
 */
export const WorktreeFilterBar = memo(({
  filter,
  onFilterChange,
  selectedCount = 0,
  onBulkSelect,
  isBulkSelectMode = false,
  onBulkArchive,
  onBulkDelete,
  className
}: WorktreeFilterBarProps) => {
  const handleFilterClick = useCallback((value: WorktreeStatusFilter) => {
    onFilterChange(value)
  }, [onFilterChange])

  return (
    <div className={cn('flex flex-col gap-2 px-2 py-1', className)}>
      {/* Status filters */}
      <div className="flex items-center gap-1 flex-wrap">
        {FILTERS.map(({ value, label, icon: Icon, color }) => (
          <motion.button
            key={value}
            onClick={() => handleFilterClick(value)}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
              'transition-colors',
              'border border-transparent',
              filter === value
                ? 'bg-primary/10 border-primary/20 text-primary'
                : 'bg-secondary/20 text-muted-foreground hover:bg-secondary/40'
            )}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <Icon className={cn('w-3.5 h-3.5', filter === value ? color : 'text-muted-foreground')} />
            <span>{label}</span>
          </motion.button>
        ))}

        {/* Bulk select toggle */}
        {onBulkSelect && (
          <motion.button
            onClick={onBulkSelect}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium',
              'transition-colors ml-auto',
              'border border-transparent',
              isBulkSelectMode
                ? 'bg-purple-500/10 border-purple-500/20 text-purple-500'
                : 'bg-secondary/20 text-muted-foreground hover:bg-secondary/40'
            )}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
          >
            <input
              type="checkbox"
              checked={isBulkSelectMode}
              onChange={() => {}}
              className="w-3.5 h-3.5 rounded border-border"
              onClick={(e) => e.stopPropagation()}
            />
            <span>Select</span>
          </motion.button>
        )}
      </div>

      {/* Bulk action buttons */}
      <AnimatePresence>
        {isBulkSelectMode && selectedCount > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-2 px-2 py-1 bg-purple-500/5 border border-purple-500/20 rounded-md"
          >
            <span className="text-xs text-muted-foreground">
              {selectedCount} selected
            </span>

            <div className="flex gap-1 ml-auto">
              {onBulkArchive && (
                <motion.button
                  onClick={onBulkArchive}
                  className="px-2 py-1 text-xs rounded bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 transition-colors"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  Archive
                </motion.button>
              )}

              {onBulkDelete && (
                <motion.button
                  onClick={onBulkDelete}
                  className="px-2 py-1 text-xs rounded bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                >
                  Delete
                </motion.button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
})

WorktreeFilterBar.displayName = 'WorktreeFilterBar'
