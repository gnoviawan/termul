/**
 * File Change Item Component
 *
 * Individual file item in the merge preview list.
 * Shows file path with appropriate icon and severity badge for conflicted files.
 * Source: Story 2.3 - Merge Preview UI
 */

import { memo, useCallback } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { File, FileCode, Image as FileImage, FileType, Archive } from 'lucide-react'
import type { FileChange, ConflictedFile, ConflictSeverity } from '@/shared/types/merge.types'

export interface FileChangeItemProps {
  file: FileChange | ConflictedFile
  status?: 'added' | 'modified' | 'deleted' | 'conflicted'
  severity?: ConflictSeverity
  onClick?: () => void
  className?: string
}

/**
 * Get file icon based on file extension
 */
function getFileIcon(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase()

  if (['ts', 'tsx', 'js', 'jsx', 'json'].includes(ext || '')) {
    return FileCode
  }
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico'].includes(ext || '')) {
    return FileImage
  }
  if (['zip', 'tar', 'gz', 'rar'].includes(ext || '')) {
    return Archive
  }

  return FileType
}

/**
 * Get severity for a file based on its path (reused from ConflictDetectionResults)
 */
function getFileSeverity(filePath: string): ConflictSeverity {
  const lowerPath = filePath.toLowerCase()

  // High severity: config files, lock files, critical infrastructure
  const highPatterns = [
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    'tsconfig.json', 'vite.config', 'tailwind.config',
    '.gitignore', 'dockerfile', 'docker-compose'
  ]
  if (highPatterns.some(pattern => lowerPath.includes(pattern))) {
    return 'high'
  }

  // Medium severity: source files
  if (/\.(ts|tsx|js|jsx|json)$/.test(lowerPath)) {
    return 'medium'
  }

  // Low severity: everything else (docs, tests, assets)
  return 'low'
}

/**
 * Severity configuration
 */
const SEVERITY_CONFIG = {
  high: {
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
    label: 'High'
  },
  medium: {
    color: 'text-yellow-500',
    bgColor: 'bg-yellow-500/10',
    label: 'Med'
  },
  low: {
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    label: 'Low'
  }
}

/**
 * FileChangeItem - Individual file item
 *
 * Displays:
 * - File icon based on type
 * - File path (truncated if long)
 * - Severity badge for conflicted files
 * - Click handler to open diff preview
 * - Keyboard navigation support
 */
export const FileChangeItem = memo(({
  file,
  status,
  severity,
  onClick,
  className
}: FileChangeItemProps) => {
  const FileIcon = getFileIcon(file.path)
  const fileSeverity = severity || getFileSeverity(file.path)
  const severityConfig = SEVERITY_CONFIG[fileSeverity]
  const isConflicted = status === 'conflicted' || 'severity' in file

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick?.()
    }
  }, [onClick])

  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0 }}
      className={cn(
        'flex items-center gap-2 px-3 py-2 text-xs font-mono border-b border-border last:border-b-0',
        'hover:bg-secondary/30 transition-colors cursor-pointer',
        className
      )}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`View diff for ${file.path}`}
    >
      <FileIcon className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate" title={file.path}>
        {file.path}
      </span>

      {/* Severity badge for conflicted files */}
      {isConflicted && (
        <span className={cn(
          'text-xs px-1.5 py-0.5 rounded capitalize flex-shrink-0',
          severityConfig.color,
          severityConfig.bgColor
        )}>
          {severityConfig.label}
        </span>
      )}
    </motion.div>
  )
})

FileChangeItem.displayName = 'FileChangeItem'
