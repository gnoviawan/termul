/**
 * WorktreeFilterBar Component
 *
 * Filter bar for filtering worktrees by status.
 * Source: Story 1.6 - Task 3.3: Create WorktreeFilterBar with status filters
 */

import { memo, useCallback } from 'react'
import { CheckCircle2, AlertCircle, AlertTriangle, ArrowUp, ArrowDown } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

export type WorktreeStatusFilter = 'all' | 'dirty' | 'ahead' | 'behind' | 'conflicted'

export interface WorktreeFilterBarProps {
  filter: WorktreeStatusFilter
  onFilterChange: (filter: WorktreeStatusFilter) => void
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
  { value: 'ahead', label: 'Ahead', icon: ArrowUp, color: 'text-blue-500' },
  { value: 'behind', label: 'Behind', icon: ArrowDown, color: 'text-yellow-500' },
  { value: 'conflicted', label: 'Conflicts', icon: AlertTriangle, color: 'text-red-500' },
]

/**
 * WorktreeFilterBar - Status filter buttons
 */
export const WorktreeFilterBar = memo(({
  filter,
  onFilterChange,
  className
}: WorktreeFilterBarProps) => {
  const handleFilterClick = useCallback((value: WorktreeStatusFilter) => {
    onFilterChange(value)
  }, [onFilterChange])

  return (
    <div className={cn('flex items-center justify-between px-2 py-1 gap-1', className)}>
      {/* Status filters - icon only, evenly distributed */}
      {FILTERS.map(({ value, icon: Icon, color }) => (
        <motion.button
          key={value}
          onClick={() => handleFilterClick(value)}
          className={cn(
            'flex-1 flex items-center justify-center h-7 rounded-md transition-colors',
            'border border-transparent',
            filter === value
              ? 'bg-primary/10 border-primary/20'
              : 'bg-secondary/20 text-muted-foreground hover:bg-secondary/40'
          )}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          title={value.charAt(0).toUpperCase() + value.slice(1)}
        >
          <Icon className={cn('w-3.5 h-3.5', filter === value ? color : 'text-muted-foreground')} />
        </motion.button>
      ))}
    </div>
  )
})

WorktreeFilterBar.displayName = 'WorktreeFilterBar'
