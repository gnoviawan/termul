/**
 * Conflict Detection Results Component
 *
 * Displays conflict detection results with loading states, success/warning messages,
 * and conflicted files list with severity indicators.
 * Source: Story 2.2 - Task 3: Create Detection Results Display
 */

import { memo } from 'react'
import { Loader2, CheckCircle2, AlertTriangle, AlertCircle, Info, RefreshCw } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { ConflictDetectionResult } from '@/shared/types/merge.types'

export interface ConflictDetectionResultsProps {
  result: ConflictDetectionResult | null
  isLoading: boolean
  error?: string | null
  onRetry?: () => void
  className?: string
  detectionMode?: 'accurate' | 'fast'
}

/**
 * Severity indicator configuration (FR15)
 */
const SEVERITY_CONFIG = {
  high: {
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/20',
    icon: AlertCircle
  },
  medium: {
    color: 'text-yellow-500',
    bgColor: 'bg-yellow-500/10',
    borderColor: 'border-yellow-500/20',
    icon: AlertTriangle
  },
  low: {
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/20',
    icon: Info
  }
}

/**
 * Get severity for a file based on its path
 */
function getFileSeverity(filePath: string): 'high' | 'medium' | 'low' {
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
 * Loading state component (NFR3 - <100ms perceived latency)
 */
function LoadingState({ detectionMode }: { detectionMode?: 'accurate' | 'fast' }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="flex flex-col items-center justify-center py-8 px-4"
    >
      <Loader2 className="w-8 h-8 animate-spin text-blue-500 mb-3" />
      <p className="text-sm text-muted-foreground">
        {detectionMode === 'fast' ? 'Running fast detection...' : 'Running accurate detection...'}
      </p>
      <p className="text-xs text-muted-foreground mt-1">
        This may take a few seconds
      </p>
    </motion.div>
  )
}

/**
 * Success state component (AC9)
 */
function SuccessState({ result }: { result: ConflictDetectionResult }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="flex items-center gap-3 p-4 rounded-lg bg-green-500/10 border border-green-500/20"
    >
      <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-medium text-green-500">
          No conflicts detected. Safe to merge.
        </p>
        {result.detectionMode === 'accurate' && (
          <p className="text-xs text-muted-foreground mt-1">
            All checks passed with high confidence
          </p>
        )}
      </div>
    </motion.div>
  )
}

/**
 * Warning state with conflicted files list (AC10, FR15)
 */
function WarningState({ result, detectionMode }: { result: ConflictDetectionResult; detectionMode?: 'accurate' | 'fast' }) {
  const confidenceText = result.detectionMode === 'accurate'
    ? 'High confidence - full merge simulation'
    : 'Medium confidence - quick status check'

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className="space-y-4"
    >
      {/* Warning banner */}
      <div className="flex items-start gap-3 p-4 rounded-lg bg-orange-500/10 border border-orange-500/20">
        <AlertTriangle className="w-5 h-5 text-orange-500 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-sm font-medium text-orange-500">
            {result.fileCount} file{result.fileCount !== 1 ? 's' : ''} will conflict. Review before merging.
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {confidenceText}
          </p>
        </div>
      </div>

      {/* Conflicted files list */}
      {result.conflictedFiles.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Conflicted Files
          </p>
          <div className="max-h-[200px] overflow-y-auto space-y-1.5">
            {result.conflictedFiles.map((filePath, index) => {
              const severity = getFileSeverity(filePath)
              const config = SEVERITY_CONFIG[severity]
              const Icon = config.icon

              return (
                <motion.div
                  key={filePath}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.03 }}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-md border',
                    config.bgColor,
                    config.borderColor
                  )}
                >
                  <Icon className={cn('w-3.5 h-3.5 flex-shrink-0', config.color)} />
                  <span className="text-xs font-mono truncate flex-1">
                    {filePath}
                  </span>
                  <span className={cn('text-xs px-1.5 py-0.5 rounded capitalize', config.color, config.bgColor)}>
                    {severity}
                  </span>
                </motion.div>
              )
            })}
          </div>
        </div>
      )}
    </motion.div>
  )
}

/**
 * Error state component
 */
function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="flex items-center gap-3 p-4 rounded-lg bg-red-500/10 border border-red-500/20"
    >
      <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-medium text-red-500">
          Detection failed
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {error || 'An unexpected error occurred'}
        </p>
      </div>
      {onRetry && (
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={onRetry}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-500/20 text-red-500 text-xs font-medium hover:bg-red-500/30 transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          Retry
        </motion.button>
      )}
    </motion.div>
  )
}

/**
 * ConflictDetectionResults - Main results display component
 */
export const ConflictDetectionResults = memo(({
  result,
  isLoading,
  error,
  onRetry,
  className,
  detectionMode
}: ConflictDetectionResultsProps) => {
  // Determine which state to show
  const getContent = () => {
    if (isLoading) {
      return <LoadingState detectionMode={detectionMode} />
    }

    if (error) {
      return <ErrorState error={error} onRetry={onRetry} />
    }

    if (!result) {
      return (
        <div className="text-center py-8 px-4 text-sm text-muted-foreground">
          Select a detection mode and click "Detect Conflicts" to begin
        </div>
      )
    }

    // No conflicts
    if (!result.hasConflicts) {
      return <SuccessState result={result} />
    }

    // Has conflicts
    return <WarningState result={result} detectionMode={detectionMode} />
  }

  return (
    <div className={cn('min-h-[120px]', className)}>
      <AnimatePresence mode="wait">
        <motion.div
          key={isLoading ? 'loading' : error ? 'error' : result?.hasConflicts ? 'warning' : 'success'}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
        >
          {getContent()}
        </motion.div>
      </AnimatePresence>
    </div>
  )
})

ConflictDetectionResults.displayName = 'ConflictDetectionResults'
