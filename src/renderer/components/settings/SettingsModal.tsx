import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'

interface SettingsModalProps {
  /** Whether the modal is visible. */
  isOpen: boolean
  /** Close handler (Esc + backdrop click + close button). The caller may
   * gate this behind an unsaved-changes confirm. */
  onClose: () => void
  /** Modal title rendered in the header. */
  title: string
  /** Optional subtitle (e.g. active project name). */
  subtitle?: ReactNode
  /** Optional icon rendered before the title. */
  icon?: ReactNode
  /** Body content — typically the existing `SettingsLayout` + sections. */
  children: ReactNode
  /** Optional footer (e.g. the Project Settings save bar). */
  footer?: ReactNode
}

/**
 * Shared framer-motion modal shell for the settings surfaces. Mirrors the
 * `NewWorktreeModal`/`CommandHistoryModal` pattern: `AnimatePresence` →
 * backdrop (`fixed inset-0 bg-black/60 backdrop-blur-sm`) → centered card.
 *
 * The card is sized wide (`w-[90vw] max-w-5xl]`) and tall
 * (`max-h-[85vh]`) to accommodate the `SettingsLayout` sidebar + scroll-spy
 * content. Esc and backdrop click call `onClose`.
 */
export function SettingsModal({
  isOpen,
  onClose,
  title,
  subtitle,
  icon,
  children,
  footer
}: SettingsModalProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  // Focus management: move focus into the dialog on open, trap Tab within
  // its focusable controls, and restore focus to the trigger on close.
  useEffect(() => {
    if (!isOpen) return
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Defer one tick so the motion.div has mounted.
    const id = requestAnimationFrame(() => cardRef.current?.focus())
    return () => {
      cancelAnimationFrame(id)
      previouslyFocusedRef.current?.focus()
    }
  }, [isOpen])

  // Handle Escape key. Defer to any open sibling dialog (ConfirmDialog) or
  // ShortcutRecorder: if one is active, let it handle Escape and skip closing
  // the settings modal — otherwise both listeners fire and the confirm is
  // dismissed without the user choosing, or the modal closes mid-recording.
  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      // A sibling dialog (ConfirmDialog reset/unsaved-confirm, etc.) is
      // open — let its own Escape handler run and don't close the modal.
      if (document.querySelector('[data-sibling-dialog]')) return
      // ShortcutRecorder is capturing — don't close the modal mid-recording.
      if (document.querySelector('[data-shortcut-recorder]')) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  // Trap Tab within the dialog card so focus doesn't leak into the workspace
  // behind the backdrop.
  useEffect(() => {
    if (!isOpen) return
    const handleTab = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Tab' || !cardRef.current) return
      const focusables = cardRef.current.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      )
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    }
    window.addEventListener('keydown', handleTab)
    return () => window.removeEventListener('keydown', handleTab)
  }, [isOpen])

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3 md:p-0"
          onClick={onClose}
        >
          <motion.div
            ref={cardRef}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="flex h-[90vh] max-h-[90vh] w-full flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl focus:outline-none md:h-[85vh] md:max-h-[85vh] md:w-[90vw] md:max-w-5xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={title}
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-3 border-b border-border bg-secondary/40 px-6 py-3">
              <div className="flex items-center gap-3">
                {icon && <div className="rounded bg-primary/10 p-2 text-primary">{icon}</div>}
                <div>
                  <h2 className="text-base font-semibold leading-tight text-foreground">{title}</h2>
                  {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                title="Close"
                aria-label={`Close ${title}`}
              >
                <X size={18} />
              </button>
            </div>

            {/* Body — flex column so SettingsLayout's `flex-1` fills the
                bounded height and the sidebar scrolls independently of the
                content area. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>

            {/* Footer */}
            {footer && <div className="border-t border-border bg-card">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
