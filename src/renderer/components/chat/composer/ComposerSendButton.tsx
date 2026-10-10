import { AnimatePresence, motion } from 'framer-motion'
import { ArrowUp, Square } from '@/components/icons'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { iconPop } from '../chat-motion'

interface ComposerSendButtonProps {
  /** A turn is running and there is nothing to send: show Stop. */
  showStop: boolean
  canSend: boolean
  /** A turn is running: a send is queued instead of dispatched. */
  busy: boolean
  reduced: boolean
  onCancel: () => void
  onSubmit: () => void | Promise<void>
}

/**
 * The composer's send / queue / stop morph. Moved verbatim out of `ChatInputBar`
 * so the desktop toolbar and the mobile one-row toolbar share one source.
 */
export function ComposerSendButton({
  showStop,
  canSend,
  busy,
  reduced,
  onCancel,
  onSubmit
}: ComposerSendButtonProps): React.JSX.Element {
  const iconMotion = iconPop(reduced)
  return (
    <div className="relative size-8 shrink-0 overflow-visible">
      <AnimatePresence initial={false} mode="popLayout">
        {showStop ? (
          <motion.button
            key="stop"
            type="button"
            data-press-feedback="off"
            onClick={onCancel}
            title="Cancel turn"
            aria-label="Cancel turn"
            initial={iconMotion.initial}
            animate={iconMotion.animate}
            exit={iconMotion.exit}
            transition={iconMotion.transition}
            className={cn(
              buttonVariants({ variant: 'composer', size: 'icon-sm' }),
              'absolute inset-0 [&_svg]:size-3.5',
              "after:absolute after:-inset-1.5 after:content-[''] @[400px]:after:-inset-1 pointer-coarse:@[400px]:after:-inset-1.5"
            )}
          >
            <Square fill="currentColor" strokeWidth={0} />
          </motion.button>
        ) : (
          <motion.button
            key="send"
            type="button"
            data-press-feedback="off"
            onClick={() => void onSubmit()}
            disabled={!canSend}
            title={busy ? 'Queue message' : 'Send'}
            aria-label={busy ? 'Queue message' : 'Send message'}
            initial={iconMotion.initial}
            animate={iconMotion.animate}
            exit={iconMotion.exit}
            transition={iconMotion.transition}
            className={cn(
              buttonVariants({ variant: 'composer', size: 'icon-sm' }),
              'absolute inset-0 [&_svg]:size-[18px]',
              "after:absolute after:-inset-1.5 after:content-[''] @[400px]:after:-inset-1 pointer-coarse:@[400px]:after:-inset-1.5"
            )}
          >
            <ArrowUp />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
