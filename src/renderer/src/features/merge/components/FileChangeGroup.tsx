/**
 * File Change Group Component
 *
 * Displays files grouped by status (Added, Modified, Deleted, Conflicted)
 * with collapsible sections and status-specific styling.
 * Source: Story 2.3 - Merge Preview UI
 */

import { memo } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { FileCheck, GitMerge, X, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import type { FileChange, ConflictedFile } from '@/shared/types/merge.types'
import { FileChangeItem } from './FileChangeItem'

export interface FileChangeGroupProps {
  status: 'added' | 'modified' | 'deleted' | 'conflicted'
  files: FileChange[] | ConflictedFile[]
  onFileClick?: (file: FileChange | ConflictedFile) => void
  className?: string
  defaultExpanded?: boolean
}

/**
 * File group configuration for status indicators
 */
const FILE_GROUP_CONFIG = {
  added: {
    color: 'text-green-500',
    bgColor: 'bg-green-500/10',
    borderColor: 'border-green-500/20',
    hoverBg: 'hover:bg-green-500/5',
    icon: FileCheck,
    label: 'Added'
  },
  modified: {
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/20',
    hoverBg: 'hover:bg-blue-500/5',
    icon: GitMerge,
    label: 'Modified'
  },
  deleted: {
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/20',
    hoverBg: 'hover:bg-red-500/5',
    icon: X,
    label: 'Deleted'
  },
  conflicted: {
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/20',
    hoverBg: 'hover:bg-red-500/5',
    icon: AlertTriangle,
    label: 'Conflicted'
  }
} as const

/**
 * FileChangeGroup - Displays collapsible group of files by status
 *
 * Color indicators:
 * - green (added)
 * - blue (modified)
 * - red (deleted/conflicted)
 * - Warning icon for conflicted files
 */
export const FileChangeGroup = memo(({
  status,
  files,
  onFileClick,
  className,
  defaultExpanded = true
}: FileChangeGroupProps) => {
  const config = FILE_GROUP_CONFIG[status]
  const Icon = config.icon

  if (files.length === 0) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'border rounded-lg overflow-hidden',
        config.borderColor,
        className
      )}
    >
      {/* Group Header */}
      <div className={cn(
        'flex items-center gap-2 px-3 py-2 border-b cursor-pointer select-none',
        config.bgColor,
        config.hoverBg
      )}>
        <Icon className={cn('w-4 h-4', config.color)} />
        <span className="text-sm font-medium text-foreground">
          {config.label} ({files.length})
        </span>
      </div>

      {/* File List */}
      <div className="max-h-[200px] overflow-y-auto">
        {files.map((file, index) => (
          <FileChangeItem
            key={file.path}
            file={file}
            status={status}
            onClick={() => onFileClick?.(file)}
            className={index % 2 === 0 ? 'bg-secondary/5' : ''}
          />
        ))}
      </div>
    </motion.div>
  )
})

FileChangeGroup.displayName = 'FileChangeGroup'
