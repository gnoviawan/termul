import { AnimatePresence, motion } from 'framer-motion'
import { type ReactNode, useEffect, useRef } from 'react'
import { useNativeWebviewOcclusion } from '@/hooks/use-native-webview-occlusion'

const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/** Controls the user can reach. Hidden pages stay mounted, so skip them. */
function renderedFocusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0
  )
}

interface SettingsModalProps {
  /** Whether the modal is visible. */
  isOpen: boolean
  /** Close handler (Esc + backdrop click; pass it to `SettingsLayout` for
   * the Close button). The caller may gate this behind an unsaved-changes
   * confirm. */
  onClose: () => void
  /** Accessible name of the dialog. The visible title lives in `SettingsLayout`. */
  title: string
  /** Body content — typically the existing `SettingsLayout` + sections. */
  children: ReactNode
  /** Optional footer (e.g. the Project Settings save bar). */
  footer?: ReactNode
}

/**
 * Shared framer-motion modal shell for the settings surfaces. Mirrors the
 * `NewWorktreeModal`/`CommandHistoryModal` pattern: `AnimatePresence` →
 * backdrop (`fixed inset-0 bg-overlay/60 backdrop-blur-sm`) → centered card.
 *
 * The card is sized wide (`w-[90vw] max-w-5xl]`) and tall
 * (`max-h-[85vh]`) to accommodate the `SettingsLayout` sidebar and its
 * one-page-at-a-time content. Esc and backdrop click call `onClose`.
 */
export function SettingsModal({
  isOpen,
  onClose,
  title,
  children,
  footer
}: SettingsModalProps): React.JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  // A custom fixed overlay: browser-pane webviews paint above it unless they hide.
  useNativeWebviewOcclusion(isOpen)

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
      // Idle recorders are always mounted (the Shortcuts section), so match
      // only the one that is recording.
      if (document.querySelector('[data-shortcut-recorder][data-recording]')) return
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
      const focusables = renderedFocusables(cardRef.current)
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/60 backdrop-blur-sm p-3 md:p-0"
          onClick={onClose}
        >
          <motion.div
            ref={cardRef}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="flex h-[90vh] max-h-[90vh] w-full flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl focus:outline-none md:h-[85vh] md:max-h-[85vh] md:w-[90vw] md:max-w-5xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={title}
          >
            {/* Body — flex column so SettingsLayout's `flex-1` fills the
                bounded height. SettingsLayout draws the titles and Close. */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>

            {/* Footer */}
            {footer && <div className="border-t border-border bg-card">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
