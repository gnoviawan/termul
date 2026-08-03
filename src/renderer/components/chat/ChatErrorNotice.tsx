import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { AlertTriangle, RotateCcw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CHAT_GUTTER_X } from './chat-layout'

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
          // Opacity-only — never animate height (layout thrash on every error).
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? { duration: 0 } : { duration: 0.15, ease: 'easeOut' }}
          className="border-b border-destructive/30 bg-destructive/10"
        >
          <div
            className={cn('mx-auto flex w-full max-w-3xl items-start gap-2 py-2', CHAT_GUTTER_X)}
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs text-destructive">
              {message}
            </p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/15 active:scale-[0.96]"
              >
                <RotateCcw className="size-3.5" />
                Retry
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss error"
              className={cn(
                'relative flex size-11 shrink-0 items-center justify-center rounded-md text-destructive/80',
                'transition-colors hover:bg-destructive/15 hover:text-destructive active:scale-[0.96]'
              )}
            >
              <X className="size-3.5" />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
