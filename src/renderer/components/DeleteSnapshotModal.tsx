import { AnimatePresence, motion } from 'framer-motion'
import { Trash2, X } from 'lucide-react'
import { type KeyboardEvent, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { Snapshot } from '@/types/project'

interface DeleteSnapshotModalProps {
  isOpen: boolean
  snapshot: Snapshot | null
  onClose: () => void
  onDelete: () => Promise<void> | void
  isDeleting: boolean
}

export function DeleteSnapshotModal({
  isOpen,
  snapshot,
  onClose,
  onDelete,
  isDeleting
}: DeleteSnapshotModalProps): React.JSX.Element {
  const { t } = useTranslation('workspace')
  // Handle Escape key to close modal
  useEffect(() => {
    if (!isOpen) return

    const handleEscape = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape' && !isDeleting) {
        e.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isOpen, isDeleting, onClose])

  const handleDelete = useCallback(async () => {
    if (!isDeleting) {
      await onDelete()
    }
  }, [isDeleting, onDelete])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && !isDeleting) {
        e.preventDefault()
        handleDelete()
      } else if (e.key === 'Escape' && !isDeleting) {
        e.preventDefault()
        onClose()
      }
    },
    [isDeleting, handleDelete, onClose]
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
                <Trash2 size={14} className="text-destructive" />
                {t('snapshots.deleteTitle')}
              </h3>
              <button
                onClick={onClose}
                disabled={isDeleting}
                className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                <X size={14} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              <p className="text-sm text-foreground">
                {t('snapshots.deleteConfirm', { name: snapshot.name })}
              </p>

              <p className="text-sm text-muted-foreground">{t('snapshots.cannotUndo')}</p>
            </div>

            {/* Footer */}
            <div className="px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
              <button
                onClick={onClose}
                disabled={isDeleting}
                className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                {t('snapshots.cancel')}
              </button>
              <button
                onClick={handleDelete}
                disabled={isDeleting}
                className="px-3 py-1.5 text-xs font-medium bg-destructive text-destructive-foreground rounded hover:bg-destructive/90 shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                <Trash2 size={12} />
                {isDeleting ? t('snapshots.deleting') : t('snapshots.delete')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
