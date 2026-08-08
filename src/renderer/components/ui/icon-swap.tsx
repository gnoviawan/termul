import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Enter — opacity + mild scale only (no blur; WKWebView can stall `mode="wait"` on filter). */
const ICON_ENTER = { duration: 0.2, ease: [0.32, 0.72, 0, 1] as const }

/** Exit — quieter and ~30% faster than enter. */
const ICON_EXIT = { duration: 0.12, ease: 'easeIn' as const }

interface IconSwapProps {
  /** Unique key per visual state — drives enter/exit crossfade. */
  iconKey: string | number | boolean
  children: ReactNode
  className?: string
}

/**
 * Cross-fade between icon states. High-frequency safe: opacity + scale ≥ 0.96,
 * never near-zero scale or blur (blur exits have stalled AnimatePresence in
 * WKWebView, leaving the previous glyph stuck while aria-label already updated).
 *
 * Under reduced motion the swap is a hard replace — no AnimatePresence — so the
 * new glyph is guaranteed to mount immediately.
 */
export function IconSwap({ iconKey, children, className }: IconSwapProps): React.JSX.Element {
  const reduced = useReducedMotion() ?? false
  const shellClass = cn(
    // Match lucide box so swap wrapper doesn't baseline-shift vs bare icons.
    'inline-flex size-3.5 shrink-0 items-center justify-center',
    className
  )

  if (reduced) {
    return (
      <span key={String(iconKey)} className={shellClass}>
        {children}
      </span>
    )
  }

  return (
    <span className={shellClass}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={String(iconKey)}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96, transition: ICON_EXIT }}
          transition={ICON_ENTER}
          className="inline-flex size-full items-center justify-center [&_svg]:block"
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
