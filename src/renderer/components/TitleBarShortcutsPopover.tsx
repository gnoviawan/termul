import { useCallback, useEffect, useRef } from 'react'
import { Keyboard } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'sonner'
import { ShortcutRecorder } from '@/components/ShortcutRecorder'
import {
  useResetShortcut,
  useUpdateShortcut
} from '@/hooks/use-keyboard-shortcuts'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import type { KeyboardShortcut } from '@/types/settings'

const QUICK_SHORTCUT_IDS = [
  'commandPalette',
  'commandHistory',
  'newTerminal',
  'newBrowserTab',
  'toggleFileExplorer',
  'sidebarToggle',
  'zoomIn',
  'zoomOut',
  'zoomReset'
] as const

interface TitleBarShortcutsPopoverProps {
  buttonClassName: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

export function TitleBarShortcutsPopover({
  buttonClassName,
  open = false,
  onOpenChange
}: TitleBarShortcutsPopoverProps): React.JSX.Element {
  const shortcuts = useKeyboardShortcutsStore((state) => state.shortcuts)
  const updateShortcut = useUpdateShortcut()
  const resetShortcut = useResetShortcut()
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  const quickShortcuts = QUICK_SHORTCUT_IDS.map((id) => shortcuts[id]).filter(
    (shortcut): shortcut is KeyboardShortcut => Boolean(shortcut)
  )

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      onOpenChange?.(nextOpen)
    },
    [onOpenChange]
  )

  const handleUpdate = (id: string, customKey: string): void => {
    void updateShortcut(id, customKey).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to save shortcut')
    })
  }

  const handleReset = (id: string): void => {
    void resetShortcut(id).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Failed to reset shortcut')
    })
  }

  useEffect(() => {
    if (!open) return

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    setTimeout(() => closeButtonRef.current?.focus(), 0)
  }, [open])

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return

      const activeElement = document.activeElement
      if (
        activeElement instanceof HTMLElement &&
        activeElement.closest('[data-shortcut-recorder="true"]')
      ) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [open, setOpen])

  return (
    <>
      <button
        type="button"
        className={buttonClassName}
        title="Keyboard shortcuts"
        aria-label="Open keyboard shortcuts menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation()
          setOpen(!open)
        }}
      >
        <Keyboard size={16} className={open ? 'text-foreground' : 'text-muted-foreground'} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[110] flex flex-col items-center pt-[7vh] bg-black/40 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="shortcut-menu-title"
              initial={{ opacity: 0, scale: 0.97, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: -8 }}
              transition={{ duration: 0.15 }}
              className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
                <div>
                  <div
                    id="shortcut-menu-title"
                    className="flex items-center gap-2 text-sm font-semibold text-foreground"
                  >
                    <Keyboard aria-hidden="true" size={15} />
                    Shortcut Menu
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    View and edit common workspace shortcuts.
                  </p>
                </div>
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  Esc
                </button>
              </div>

              <div className="max-h-[52vh] overflow-y-auto px-2 py-2">
                {quickShortcuts.length === 0 ? (
                  <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                    No shortcuts available.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {quickShortcuts.map((shortcut) => (
                      <ShortcutRecorder
                        key={shortcut.id}
                        shortcut={shortcut}
                        allShortcuts={shortcuts}
                        onUpdate={handleUpdate}
                        onReset={handleReset}
                        variant="compact"
                      />
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
