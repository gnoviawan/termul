import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const ICON_SPRING = { type: 'spring' as const, duration: 0.3, bounce: 0 }

interface IconSwapProps {
  /** Unique key per visual state — drives enter/exit crossfade. */
  iconKey: string | number | boolean
  children: ReactNode
  className?: string
}

/**
 * Cross-fade between icon states with scale, opacity, and blur (make-interfaces
 * contextual icon animation pattern).
 */
export function IconSwap({ iconKey, children, className }: IconSwapProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false

  return (
    <span
      className={cn(
        // Match lucide box so swap wrapper doesn't baseline-shift vs bare icons.
        'inline-flex size-3.5 shrink-0 items-center justify-center',
        className
      )}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={String(iconKey)}
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
          transition={reduced ? { duration: 0.15, ease: 'easeOut' } : ICON_SPRING}
          className="inline-flex size-full items-center justify-center [&_svg]:block"
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
