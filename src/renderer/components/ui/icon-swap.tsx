import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'

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
    <span className={className}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={String(iconKey)}
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
          transition={reduced ? { duration: 0.15, ease: 'easeOut' } : ICON_SPRING}
          className="inline-flex items-center justify-center"
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
