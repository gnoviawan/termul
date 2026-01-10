import { useEffect, useCallback, KeyboardEvent } from 'react'
import { X, AlertTriangle, RotateCcw } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Snapshot } from '@/types/project'

interface RestoreSnapshotModalProps {
  isOpen: boolean
  snapshot: Snapshot | null
  hasRunningProcesses: boolean
  onClose: () => void
  onRestore: () => Promise<void> | void
  isRestoring: boolean
}

export function RestoreSnapshotModal({
  isOpen,
  snapshot,
  hasRunningProcesses,
  onClose,
  onRestore,
  isRestoring
}: RestoreSnapshotModalProps): React.JSX.Element {
  // Handle Escape key to close modal
  useEffect(() => {
    if (!isOpen) return

    const handleEscape = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !isRestoring) {
        e.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isOpen, isRestoring, onClose])

  const handleRestore = useCallback(async () => {
    if (!isRestoring) {
      await onRestore()
    }
  }, [isRestoring, onRestore])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && !isRestoring) {
        e.preventDefault()
        handleRestore()
      } else if (e.key === 'Escape' && !isRestoring) {
        e.preventDefault()
        onClose()
      }
    },
    [isRestoring, handleRestore, onClose]
  )

  return (
    <AnimatePresence>
      {isOpen && snapshot && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl w-[480px] border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/50">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <RotateCcw size={14} />
                Restore Snapshot
              </h3>
              <button
                onClick={onClose}
                disabled={isRestoring}
                className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                <X size={14} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              <p className="text-sm text-foreground">
                Are you sure you want to restore the snapshot{' '}
                <span className="font-semibold">&quot;{snapshot.name}&quot;</span>?
              </p>

              <p className="text-sm text-muted-foreground">
                This will close all current terminals and recreate {snapshot.paneCount} terminal
                {snapshot.paneCount !== 1 ? 's' : ''} from the snapshot.
              </p>

              {hasRunningProcesses && (
                <div className="bg-yellow-900/20 border border-yellow-800/50 rounded p-3 flex items-start gap-2">
                  <AlertTriangle size={16} className="text-yellow-400 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-yellow-400">
                    <span className="font-medium">Warning:</span> You have terminals with running
                    processes. Restoring will terminate these processes.
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
              <button
                onClick={onClose}
                disabled={isRestoring}
                className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleRestore}
                disabled={isRestoring}
                className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded hover:bg-primary/90 shadow-md shadow-primary/20 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                <RotateCcw size={12} className={isRestoring ? 'animate-spin' : ''} />
                {isRestoring ? 'Restoring...' : 'Restore'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
