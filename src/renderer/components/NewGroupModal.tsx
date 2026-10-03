import { AnimatePresence, motion } from 'framer-motion'
import { type KeyboardEvent, useCallback, useEffect, useState } from 'react'
import { X } from '@/components/icons'
import { Button } from '@/components/ui/button'

interface NewGroupModalProps {
  isOpen: boolean
  onClose: () => void
  onSubmit: (name: string) => void
  title?: string
  submitLabel?: string
  initialValue?: string
  placeholder?: string
}

export function NewGroupModal({
  isOpen,
  onClose,
  onSubmit,
  title = 'Create New Group',
  submitLabel = 'Create',
  initialValue = '',
  placeholder = 'Enter group name...'
}: NewGroupModalProps) {
  const [name, setName] = useState(initialValue)

  // Reset name when modal opens
  useEffect(() => {
    if (isOpen) {
      setName(initialValue)
    }
  }, [isOpen, initialValue])

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

  const handleSubmit = useCallback(() => {
    const trimmedName = name.trim()
    if (trimmedName) {
      onSubmit(trimmedName)
      onClose()
    }
  }, [name, onSubmit, onClose])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && name.trim()) {
        e.preventDefault()
        handleSubmit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [name, handleSubmit, onClose]
  )

  return (
    <AnimatePresence>
      {isOpen && (
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
            className="bg-card rounded-lg shadow-2xl w-[400px] border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKeyDown}
          >
            {/* Header */}
            <div className="px-4 py-3 border-b border-border flex justify-between items-center bg-secondary/50">
              <h3 className="text-sm font-semibold text-foreground">{title}</h3>
              <button
                onClick={onClose}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Group Folder Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={placeholder}
                  className="w-full bg-secondary border border-border rounded px-3 py-1.5 text-sm text-foreground focus:ring-1 focus:ring-primary focus:border-primary outline-none placeholder-muted-foreground"
                />
              </div>
            </div>

            {/* Footer */}
            <div className="px-4 py-3 bg-secondary/50 flex justify-end gap-2 border-t border-border">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={handleSubmit} disabled={!name.trim()}>
                {submitLabel}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
