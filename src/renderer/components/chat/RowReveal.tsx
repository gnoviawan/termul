import { motion, useReducedMotion } from 'framer-motion'
import { type ReactNode, useState } from 'react'
import { cn } from '@/lib/utils'
import { rowReveal } from './chat-motion'

interface RowRevealProps {
  /** Play the reveal; false renders the row in place (history, remounts). */
  animate: boolean
  /** Position inside the arrival burst; drives the capped stagger delay. */
  staggerIndex?: number
  children: ReactNode
}

/**
 * Reveals a newly arrived agent-activity row by growing its grid track from
 * 0fr to 1fr while the content fades up. Growing the height (instead of
 * popping in at full size) lets the stick-to-bottom scroller follow frame by
 * frame, so the list glides rather than jumping one row at once.
 */
export function RowReveal({
  animate,
  staggerIndex = 0,
  children
}: RowRevealProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  // Decided once at mount: switching element trees later would remount the row and drop its state.
  const [reveal] = useState(() => ({ play: animate && !reduced, staggerIndex }))
  // Clip only while the track grows; afterwards focus rings and popovers must not be cut.
  const [settled, setSettled] = useState(!reveal.play)
  if (!reveal.play) return <div data-row-reveal="static">{children}</div>

  const { shell, content } = rowReveal(reveal.staggerIndex)
  return (
    <motion.div
      data-row-reveal={settled ? 'settled' : 'revealing'}
      className="grid"
      initial={shell.initial}
      animate={shell.animate}
      transition={shell.transition}
      onAnimationComplete={() => setSettled(true)}
    >
      <motion.div
        className={cn('min-h-0', !settled && 'overflow-hidden')}
        initial={content.initial}
        animate={content.animate}
        transition={content.transition}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}
