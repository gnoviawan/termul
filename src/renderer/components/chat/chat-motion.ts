import type { TargetAndTransition, Transition } from 'framer-motion'

/**
 * Shared motion vocabulary for the agent chat. One "brand spring" keeps every
 * chat animation (bubbles, tool cards, scroll button, send morph) feeling like
 * the same product. Lively but restrained: a small overshoot, nothing cartoonish.
 */

/** Snappy spring with a slight overshoot — the chat's signature motion. */
export const CHAT_SPRING: Transition = {
  type: 'spring',
  stiffness: 520,
  damping: 30,
  mass: 0.8
}

/** Calmer spring (no perceptible overshoot) for long/streaming content. */
export const CHAT_SPRING_SOFT: Transition = {
  type: 'spring',
  stiffness: 420,
  damping: 38,
  mass: 0.9
}

/**
 * Disclosure chevron rotate — short ease-out, not the brand spring.
 * Expand/collapse is frequent; overshoot reads as noise.
 */
export const CHEVRON_TRANSITION: Transition = {
  duration: 0.15,
  ease: 'easeOut'
}

/** Icon swap enter — opacity + mild scale, no blur (GPU-cheap, high-frequency safe). */
const ICON_ENTER: Transition = {
  duration: 0.2,
  ease: [0.32, 0.72, 0, 1]
}

/** Icon swap exit — quieter and ~30% faster than enter. */
const ICON_EXIT: Transition = {
  duration: 0.12,
  ease: 'easeIn'
}

/** Reduced-motion fallback: snap with no perceptible motion. */
const REDUCED_TRANSITION: Transition = { duration: 0 }

export type BubbleAlign = 'start' | 'end' | 'neutral'

export interface EnterMotion {
  initial: TargetAndTransition
  animate: TargetAndTransition
  transition: Transition
}

export interface IconPopMotion extends EnterMotion {
  /** Quieter leave state for AnimatePresence exit. */
  exit: TargetAndTransition
  exitTransition: Transition
}

/**
 * Entrance for a chat row. Direction encodes sender: user bubbles drift in from
 * the right, assistant from the left, tool/neutral rows rise straight up. Under
 * reduced-motion every variant collapses to an instant appear (no fade/travel).
 */
export function bubbleEnter(align: BubbleAlign, reduced: boolean): EnterMotion {
  if (reduced) {
    return {
      initial: { opacity: 1 },
      animate: { opacity: 1 },
      transition: REDUCED_TRANSITION
    }
  }

  if (align === 'end') {
    return {
      initial: { opacity: 0, y: 8, x: 12, scale: 0.96 },
      animate: { opacity: 1, y: 0, x: 0, scale: 1 },
      transition: CHAT_SPRING
    }
  }

  if (align === 'start') {
    return {
      initial: { opacity: 0, y: 8, x: -6 },
      animate: { opacity: 1, y: 0, x: 0 },
      transition: CHAT_SPRING_SOFT
    }
  }

  return {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: CHAT_SPRING_SOFT
  }
}

/**
 * Staggered child enter inside a message row — prose, media, actions each fade
 * in with an incremental delay (~80ms steps). Identical to `bubbleEnter` for a
 * given alignment, only deferred by `delay`.
 */
export function staggerChild(
  delay: number,
  reduced: boolean,
  align: BubbleAlign = 'neutral'
): EnterMotion {
  const enter = bubbleEnter(align, reduced)
  return { ...enter, transition: { ...enter.transition, delay } }
}

/**
 * Pop used for high-frequency icon swaps (send↔stop, pending chevron, plan
 * status). Opacity + scale ≥ 0.96 only — never near-zero scale or blur.
 */
export function iconPop(reduced: boolean): IconPopMotion {
  if (reduced) {
    return {
      initial: { opacity: 1 },
      animate: { opacity: 1 },
      exit: { opacity: 1 },
      transition: REDUCED_TRANSITION,
      exitTransition: REDUCED_TRANSITION
    }
  }
  return {
    initial: { opacity: 0, scale: 0.96 },
    animate: { opacity: 1, scale: 1 },
    exit: { opacity: 0, transition: ICON_EXIT },
    transition: ICON_ENTER,
    exitTransition: ICON_EXIT
  }
}
