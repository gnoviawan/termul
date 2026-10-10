import type { HTMLMotionProps } from 'framer-motion'
import { EASE_OUT } from '@/lib/motion'

/**
 * Width-reveal transition props for the projects sidebar and the file
 * explorer column: 0 → auto width + fade in (~200ms), faster collapse on
 * exit (~150ms). The wrapper animates the width and clips overflow; the
 * inner content keeps its own fixed width so it clips rather than squishes.
 * Under prefers-reduced-motion both directions apply instantly.
 */
export function panelRevealMotion(
  reducedMotion: boolean
): Pick<HTMLMotionProps<'div'>, 'initial' | 'animate' | 'exit'> {
  return {
    initial: reducedMotion ? false : { width: 0, opacity: 0 },
    animate: {
      width: 'auto',
      opacity: 1,
      transition: reducedMotion ? { duration: 0 } : { duration: 0.2, ease: EASE_OUT }
    },
    exit: reducedMotion
      ? { opacity: 0, transition: { duration: 0 } }
      : { width: 0, opacity: 0, transition: { duration: 0.15, ease: EASE_OUT } }
  }
}

/**
 * Enter/exit for the web-only slim edge toggles that replace a hidden
 * sidebar/explorer. They live in the same AnimatePresence as the panel, so
 * they mount the moment the panel starts collapsing — hold them width-0 and
 * transparent for the panel's 150ms exit so the toggle never briefly
 * double-occupies then jitters.
 */
export function edgeToggleMotion(
  reducedMotion: boolean
): Pick<HTMLMotionProps<'div'>, 'initial' | 'animate' | 'exit'> {
  return {
    initial: reducedMotion ? false : { width: 0, opacity: 0 },
    animate: {
      width: 'auto',
      opacity: 1,
      transition: reducedMotion ? { duration: 0 } : { duration: 0.1, delay: 0.15, ease: EASE_OUT }
    },
    exit: reducedMotion
      ? { opacity: 0, transition: { duration: 0 } }
      : { width: 0, opacity: 0, transition: { duration: 0.1, ease: EASE_OUT } }
  }
}
