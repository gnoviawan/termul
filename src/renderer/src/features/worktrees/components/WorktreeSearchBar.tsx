/**
 * WorktreeSearchBar Component
 *
 * Search bar for filtering worktrees by branch name.
 * Appears when worktree count >= 10.
 * Source: Story 1.6 - Task 3.1: Create WorktreeSearchBar component
 */

import { memo, useState, useCallback, useEffect } from 'react'
import { Search, X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

export interface WorktreeSearchBarProps {
  value: string
  onChange: (value: string) => void
  count?: number
  threshold?: number
  className?: string
}

/**
 * WorktreeSearchBar - Search input for filtering worktrees
 */
export const WorktreeSearchBar = memo(({
  value,
  onChange,
  count = 0,
  threshold = 10,
  className
}: WorktreeSearchBarProps) => {
  const [localValue, setLocalValue] = useState(value)
  const [isFocused, setIsFocused] = useState(false)

  // Sync with external value
  useEffect(() => {
    setLocalValue(value)
  }, [value])

  // Debounced search (300ms)
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      onChange(localValue)
    }, 300)

    return () => clearTimeout(timeoutId)
  }, [localValue, onChange])

  const handleClear = useCallback(() => {
    setLocalValue('')
    onChange('')
  }, [onChange])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      handleClear()
    }
  }, [handleClear])

  // Don't render if below threshold and no active search
  if (count < threshold && !localValue) {
    return null
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, height: 0 }}
        animate={{ opacity: 1, height: 'auto' }}
        exit={{ opacity: 0, height: 0 }}
        transition={{ duration: 0.15 }}
        className={cn('px-2 py-1', className)}
      >
        <div className={cn(
          'relative flex items-center gap-2 px-3 py-1.5 rounded-md',
          'bg-secondary/30 border border-border/50',
          'transition-colors',
          isFocused && 'border-border bg-secondary/50'
        )}>
          <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />

          <input
            type="text"
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            placeholder={`Search ${count} worktree${count !== 1 ? 's' : ''}...`}
            className="flex-1 bg-transparent border-none outline-none text-xs text-foreground placeholder:text-muted-foreground"
          />

          <AnimatePresence>
            {localValue && (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                onClick={handleClear}
                className="flex-shrink-0 p-0.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </AnimatePresence>
  )
})

WorktreeSearchBar.displayName = 'WorktreeSearchBar'
