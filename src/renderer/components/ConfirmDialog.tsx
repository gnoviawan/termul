import { AnimatePresence, motion } from 'framer-motion'
import { type KeyboardEvent, useCallback, useEffect, useId } from 'react'
import { AlertTriangle } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'

/**
 * Prefix of the id each open `ConfirmDialog` registers on the overlay stack, so
 * a caller can tell from the store that a confirm is (still) open
 * (`lib/confirm-focus-return`).
 */
export const CONFIRM_DIALOG_OVERLAY_PREFIX = 'confirm-dialog:'

interface ConfirmDialogProps {
  isOpen: boolean
  title: string
  message: string
  children?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  secondaryAction?: {
    label: string
    onClick: () => void
  }
  variant?: 'default' | 'danger'
  isLoading?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  secondaryAction,
  variant = 'default',
  isLoading = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element {
  // Mobile web shell: system back cancels this dialog (inert on desktop).
  const overlayId = `${CONFIRM_DIALOG_OVERLAY_PREFIX}${useId()}`
  useOverlayRegistration(overlayId, isOpen, onCancel, { mobileShellOnly: true })

  // Handle Escape key to close dialog
  useEffect(() => {
    if (!isOpen) return

    const handleEscape = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isOpen, onCancel])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    },
    [onConfirm, onCancel]
  )

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          data-sibling-dialog
          className="fixed inset-0 bg-overlay/60 backdrop-blur-sm z-50 flex items-center justify-center"
          onClick={onCancel}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl w-[400px] border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
            tabIndex={-1}
          >
            {/* Content */}
            <div className="p-6">
              <div className="flex items-start gap-4">
                {variant === 'danger' && (
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center">
                    <AlertTriangle className="w-5 h-5 text-destructive" />
                  </div>
                )}
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-foreground mb-1">{title}</h3>
                  <p className="text-sm text-muted-foreground">{message}</p>
                  {children && <div className="mt-4">{children}</div>}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onCancel}
                disabled={isLoading}
              >
                {cancelLabel}
              </Button>
              {secondaryAction && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={secondaryAction.onClick}
                  disabled={isLoading}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  {secondaryAction.label}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant={variant === 'danger' ? 'destructive' : 'default'}
                onClick={onConfirm}
                disabled={isLoading}
              >
                {isLoading ? 'Loading...' : confirmLabel}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
