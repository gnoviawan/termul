/**
 * Diff Preview Component
 *
 * Side-by-side diff view showing before/after comparison
 * with line-by-line highlighting and conflict marker support.
 * Source: Story 2.3 - Merge Preview UI
 */

import { memo, useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { X, Loader2, AlertCircle } from 'lucide-react'
import type { FileChange, ConflictedFile } from '@/shared/types/merge.types'

export interface DiffPreviewProps {
  isOpen: boolean
  file: FileChange | ConflictedFile | null
  projectId: string
  sourceBranch: string
  targetBranch: string
  onClose: () => void
}

interface DiffLine {
  lineNumber: number
  content: string
  type: 'added' | 'removed' | 'context' | 'conflict-our' | 'conflict-their' | 'conflict-separator'
}

/**
 * Simple diff result type
 */
interface DiffResult {
  before: string[]
  after: string[]
  hasConflicts: boolean
}

/**
 * DiffPreview - Side-by-side diff view
 *
 * Shows:
 * - Before/After comparison
 * - Line-by-line highlighting
 * - Conflict marker highlighting for conflicted files
 * - Loading state during diff generation
 *
 * Note: Full diff implementation would integrate with a diff library.
 * This is a simplified placeholder that shows the structure.
 */
export const DiffPreview = memo(({
  isOpen,
  file,
  projectId,
  sourceBranch,
  targetBranch,
  onClose
}: DiffPreviewProps) => {
  const [isLoading, setIsLoading] = useState(false)
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Reset state when file changes
  useEffect(() => {
    if (file) {
      setIsLoading(true)
      setError(null)
      // TODO: Integrate with IPC to get actual diff
      // For now, simulate loading and show placeholder
      setTimeout(() => {
        setDiffResult({
          before: ['// Before content', 'line 1', 'line 2'],
          after: ['// After content', 'line 1', 'line 2', 'line 3 (added)'],
          hasConflicts: 'severity' in file
        })
        setIsLoading(false)
      }, 500)
    } else {
      setDiffResult(null)
      setError(null)
    }
  }, [file])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose()
    }
  }

  if (!isOpen) return null

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl w-full max-w-6xl border border-border overflow-hidden max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            tabIndex={-1}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-semibold text-foreground truncate">
                  {file?.path}
                </h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Diff: {sourceBranch} → {targetBranch}
                </p>
              </div>
              <button
                onClick={onClose}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-hidden flex">
              {/* Loading State */}
              {isLoading && (
                <div className="flex flex-col items-center justify-center w-full py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-blue-500 mb-3" />
                  <p className="text-sm text-muted-foreground">
                    Loading diff...
                  </p>
                </div>
              )}

              {/* Error State */}
              {error && !isLoading && (
                <div className="flex flex-col items-center justify-center w-full py-12">
                  <AlertCircle className="w-8 h-8 text-red-500 mb-3" />
                  <p className="text-sm text-red-500">
                    {error}
                  </p>
                </div>
              )}

              {/* Diff View */}
              {!isLoading && !error && diffResult && (
                <div className="flex-1 flex overflow-hidden">
                  {/* Before (Left) */}
                  <div className="flex-1 border-r border-border overflow-y-auto">
                    <div className="px-4 py-2 bg-red-500/10 border-b border-border text-xs font-medium text-red-500">
                      Before ({targetBranch})
                    </div>
                    <div className="p-4 font-mono text-xs space-y-1">
                      {diffResult.before.map((line, i) => (
                        <div key={i} className="flex gap-2">
                          <span className="text-muted-foreground select-none w-8 text-right">{i + 1}</span>
                          <span className="flex-1 text-red-500 bg-red-500/5">- {line}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* After (Right) */}
                  <div className="flex-1 overflow-y-auto">
                    <div className="px-4 py-2 bg-green-500/10 border-b border-border text-xs font-medium text-green-500">
                      After ({sourceBranch})
                    </div>
                    <div className="p-4 font-mono text-xs space-y-1">
                      {diffResult.after.map((line, i) => (
                        <div key={i} className="flex gap-2">
                          <span className="text-muted-foreground select-none w-8 text-right">{i + 1}</span>
                          <span className={cn(
                            'flex-1',
                            line.includes('(added)') ? 'text-green-500 bg-green-500/5' : ''
                          )}>
                            {line.includes('(added)') ? '+ ' : '  '}{line.replace(' (added)', '')}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end px-6 py-4 border-t border-border bg-secondary/20 flex-shrink-0">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
              >
                Close
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
})

DiffPreview.displayName = 'DiffPreview'
