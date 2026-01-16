/**
 * Shortcut Remap Dialog Component
 *
 * Dialog for remapping keyboard shortcuts with key capture.
 * Source: Story 3.3 - Task 4.4: Create ShortcutRemapDialog component
 */

import { useCallback } from 'react'
import { X, RotateCcw } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { KeyboardShortcut, Keybinding } from '@shared/types/keyboard-shortcuts.types'

interface ShortcutRemapDialogProps {
  isOpen: boolean
  shortcut: KeyboardShortcut
  capturedKeybinding: Keybinding | null
  conflictWarning: string | null
  onSave: () => Promise<void>
  onCancel: () => void
}

/**
 * Format keybinding for display
 */
function formatKeybinding(keybinding: Keybinding): string {
  const { modifier, key } = keybinding

  let displayModifier: 'cmd' | 'ctrl' | 'alt' | 'shift' | 'meta' = modifier
  if (typeof window !== 'undefined' && window.navigator.platform) {
    const platform = window.navigator.platform
    if (modifier === 'cmd' && !platform.startsWith('darwin')) {
      displayModifier = 'ctrl'
    }
  }

  const formattedModifier = displayModifier.charAt(0).toUpperCase() + displayModifier.slice(1)
  const formattedKey = key.charAt(0).toUpperCase() + key.slice(1)

  return `${formattedModifier}+${formattedKey}`
}

/**
 * ShortcutRemapDialog - Modal dialog for remapping shortcuts
 *
 * Shows instructions for key capture and displays captured keybinding.
 * Includes conflict warnings and save/cancel buttons.
 */
export function ShortcutRemapDialog({
  isOpen,
  shortcut,
  capturedKeybinding,
  conflictWarning,
  onSave,
  onCancel
}: ShortcutRemapDialogProps) {
  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (!isOpen) return

    // Escape cancels
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
  }, [isOpen, onCancel])

  // Register keyboard listener for escape
  useCallback(() => {
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown)
      return () => window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, handleKeyDown])

  const handleBackdropClick = useCallback((event: React.MouseEvent) => {
    if (event.target === event.currentTarget) {
      onCancel()
    }
  }, [onCancel])

  const handleSave = useCallback(async () => {
    await onSave()
  }, [onSave])

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={handleBackdropClick}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="relative bg-card border border-border rounded-lg shadow-xl w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-border">
              <h2 className="text-lg font-semibold text-foreground">
                Remap Shortcut
              </h2>
              <button
                onClick={onCancel}
                className="p-1 hover:bg-secondary rounded transition-colors"
              >
                <X size={20} className="text-muted-foreground" />
              </button>
            </div>

            {/* Content */}
            <div className="p-6 space-y-4">
              {/* Shortcut info */}
              <div>
                <p className="text-sm font-medium text-foreground mb-1">
                  {shortcut.description}
                </p>
                <p className="text-xs text-muted-foreground">
                  Command: <code className="text-xs bg-secondary px-1.5 py-0.5 rounded">{shortcut.command}</code>
                </p>
              </div>

              {/* Instructions */}
              <div className="p-4 bg-secondary/50 border border-border rounded">
                <p className="text-sm text-foreground">
                  Press the new key combination...
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Use modifier keys (Cmd, Ctrl, Alt, Shift) + any key
                </p>
                <p className="text-xs text-muted-foreground">
                  Press <kbd className="text-xs bg-secondary px-1.5 py-0.5 rounded">Escape</kbd> to cancel
                </p>
              </div>

              {/* Captured keybinding */}
              {capturedKeybinding && (
                <div className="p-4 bg-primary/10 border border-primary/30 rounded">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-foreground">Captured:</span>
                    <kbd className="text-lg font-mono text-primary bg-background px-3 py-1.5 rounded">
                      {formatKeybinding(capturedKeybinding)}
                    </kbd>
                  </div>
                </div>
              )}

              {/* Conflict warning */}
              {conflictWarning && (
                <div className="p-3 bg-destructive/10 border border-destructive/30 rounded">
                  <p className="text-sm text-destructive">
                    {conflictWarning}
                  </p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 p-6 border-t border-border">
              <button
                onClick={onCancel}
                className="px-4 py-2 text-sm text-foreground hover:bg-secondary rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!capturedKeybinding || !!conflictWarning}
                className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <RotateCcw size={16} />
                Save
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
