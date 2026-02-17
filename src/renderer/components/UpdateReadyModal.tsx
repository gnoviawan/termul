import { useEffect, useCallback, KeyboardEvent } from 'react'
import { X, Download, AlertTriangle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

interface UpdateReadyModalProps {
  isOpen: boolean
  version: string
  releaseNotes?: string
  hasActiveTerminals: boolean
  onInstallWhenQuit: () => void
  onRestartNow: () => void
  onSkip: () => void
  onClose: () => void
}

export function UpdateReadyModal({
  isOpen,
  version,
  releaseNotes,
  hasActiveTerminals,
  onInstallWhenQuit,
  onRestartNow,
  onSkip,
  onClose
}: UpdateReadyModalProps): React.JSX.Element {
  // Handle Escape key to close modal
  useEffect(() => {
    if (!isOpen) return

    const handleEscape = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [onClose]
  )

  return (
    <AnimatePresence>
      {isOpen && (
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
            className="bg-card rounded-lg shadow-2xl w-[500px] border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            tabIndex={-1}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/50">
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded bg-green-500/10 flex items-center justify-center">
                  <Download className="w-3 h-3 text-green-500" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">Update Ready to Install</h3>
              </div>
              <button
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              {/* Version Info */}
              <div>
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-xs font-medium text-muted-foreground">Version</span>
                  <span className="text-sm font-semibold text-foreground">{version}</span>
                </div>
              </div>

              {/* Release Notes */}
              {releaseNotes && (
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                    Release Notes
                  </label>
                  <div className="bg-secondary border border-border rounded px-3 py-2 text-sm text-foreground max-h-[200px] overflow-y-auto">
                    <div className="whitespace-pre-wrap text-xs leading-relaxed">{releaseNotes}</div>
                  </div>
                </div>
              )}

              {/* Warning about running terminals */}
              {hasActiveTerminals && (
                <div className="flex items-start gap-2 bg-amber-500/5 border border-amber-500/20 rounded px-3 py-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      You have active terminal sessions. Restarting will close all terminals. Make sure
                      you've saved any important work.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border flex-wrap">
              <button
                onClick={onSkip}
                className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Skip This Version
              </button>
              <button
                onClick={onRestartNow}
                disabled={hasActiveTerminals}
                className="px-3 py-1.5 text-xs font-medium rounded border border-border bg-secondary text-foreground hover:bg-secondary/80 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Restart Now
              </button>
              <button
                onClick={onInstallWhenQuit}
                className="px-3 py-1.5 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700 shadow-md shadow-green-500/20 transition-all"
              >
                Install When I Quit
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
