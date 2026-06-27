import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { AlertTriangle, RotateCcw, X } from 'lucide-react'

interface ChatErrorNoticeProps {
  /** Error text to show, or null/empty to hide. */
  message: string | null
  /** Re-run the latest user turn; omitted when there's nothing to retry. */
  onRetry?: () => void
  onDismiss: () => void
}

/** Dismissible inline error with a retry affordance for a failed/cancelled turn. */
export function ChatErrorNotice({
  message,
  onRetry,
  onDismiss
}: ChatErrorNoticeProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  return (
    <AnimatePresence initial={false}>
      {message && (
        <motion.div
          initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="overflow-hidden border-b border-destructive/30 bg-destructive/10"
        >
          <div className="mx-auto flex w-full max-w-3xl items-start gap-2 px-5 py-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-2xs text-destructive">
              {message}
            </p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs font-medium text-destructive transition-colors hover:bg-destructive/15 active:scale-[0.96]"
              >
                <RotateCcw className="size-3" />
                Retry
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss error"
              className="flex shrink-0 items-center justify-center rounded-md p-0.5 text-destructive/80 transition-colors hover:bg-destructive/15 hover:text-destructive active:scale-[0.96]"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
