import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useId, useState } from 'react'
import { X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  COMPOSER_DOCK_TEXT_ACTION_CLASS,
  ComposerDock,
  ComposerDockActions,
  ComposerDockDetails,
  ComposerDockMessage,
  ComposerDockRow
} from './composer/ComposerDock'

interface ChatErrorNoticeProps {
  /** Error text to show, or null/empty to hide. */
  message: string | null
  /** Lead sentence before the error text. */
  title?: string
  code?: number | null
  data?: unknown
  /** Re-run the latest user turn; omitted when there's nothing to retry. */
  onRetry?: () => void
  /** Visible label for `onRetry`. Process stop uses “Resume chat”. */
  retryLabel?: string
  onDismiss: () => void
}

/**
 * Failed or cancelled turn, docked at the top of the composer card: what
 * happened, the technical details on demand, and Retry as the one next step.
 */
export function ChatErrorNotice({
  message,
  title = 'The last turn did not finish.',
  code = null,
  data,
  onRetry,
  retryLabel = 'Retry',
  onDismiss
}: ChatErrorNoticeProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const [showDetails, setShowDetails] = useState(false)
  const detailsId = useId()
  const hasDetails = code !== null || data !== undefined
  return (
    <AnimatePresence initial={false}>
      {message && (
        <motion.div
          // Opacity-only — never animate height (layout thrash on every error).
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduced ? { duration: 0 } : { duration: 0.15, ease: 'easeOut' }}
        >
          <ComposerDock tone="destructive" role="alert" data-testid="chat-error-notice">
            <ComposerDockRow>
              <ComposerDockMessage title={title}>{message}</ComposerDockMessage>
              <ComposerDockActions>
                {hasDetails && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    aria-expanded={showDetails}
                    aria-controls={detailsId}
                    onClick={() => setShowDetails((open) => !open)}
                    className={COMPOSER_DOCK_TEXT_ACTION_CLASS}
                  >
                    {showDetails ? 'Hide details' : 'Details'}
                  </Button>
                )}
                {onRetry && (
                  <Button type="button" size="xs" onClick={onRetry} className="px-3">
                    {retryLabel}
                  </Button>
                )}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  onClick={onDismiss}
                  aria-label="Dismiss error"
                  className="text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground [&_svg]:size-3"
                >
                  <X />
                </Button>
              </ComposerDockActions>
            </ComposerDockRow>
            {hasDetails && (
              <ComposerDockDetails id={detailsId} hidden={!showDetails} className="space-y-1">
                {code !== null && <p className="select-all">Code {code}</p>}
                {data !== undefined && (
                  <pre
                    data-testid="chat-error-data"
                    className="max-h-40 select-all overflow-auto whitespace-pre-wrap break-all"
                  >
                    {JSON.stringify(data, null, 2)}
                  </pre>
                )}
              </ComposerDockDetails>
            )}
          </ComposerDock>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
