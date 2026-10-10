import { AnimatePresence, motion } from 'framer-motion'
import { type KeyboardEvent, useCallback, useEffect, useId } from 'react'
import { AlertTriangle, RotateCcw, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'
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
  // Mobile web shell: system back closes this modal through the page's own
  // close, which vetoes while a restore is in flight (inert on desktop).
  const overlayId = `restore-snapshot-modal:${useId()}`
  useOverlayRegistration(overlayId, isOpen && snapshot !== null, onClose, {
    mobileShellOnly: true
  })

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
          className="fixed inset-0 bg-overlay/60 backdrop-blur-sm z-50 flex items-center justify-center"
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
                <div className="bg-warning/10 border border-warning/50 rounded p-3 flex items-start gap-2">
                  <AlertTriangle size={16} className="text-warning mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-warning">
                    <span className="font-medium">Warning:</span> You have terminals with running
                    processes. Restoring will terminate these processes.
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                disabled={isRestoring}
              >
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={handleRestore} disabled={isRestoring}>
                {isRestoring ? <Spinner size={12} decorative /> : <RotateCcw />}
                {isRestoring ? 'Restoring...' : 'Restore'}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
