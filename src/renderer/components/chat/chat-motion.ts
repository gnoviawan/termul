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

/** Reduced-motion fallback: a quick opacity fade, no transform. */
const REDUCED_TRANSITION: Transition = { duration: 0.15, ease: 'easeOut' }

export type BubbleAlign = 'start' | 'end' | 'neutral'

export interface EnterMotion {
  initial: TargetAndTransition
  animate: TargetAndTransition
  transition: Transition
}

/**
 * Entrance for a chat row. Direction encodes sender: user bubbles drift in from
 * the right, assistant from the left, tool/neutral rows rise straight up. Under
 * reduced-motion every variant collapses to an opacity-only fade.
 */
export function bubbleEnter(align: BubbleAlign, reduced: boolean): EnterMotion {
  if (reduced) {
    return {
      initial: { opacity: 0 },
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
      initial: { opacity: 0, y: 8, x: -6, scale: 0.98 },
      animate: { opacity: 1, y: 0, x: 0, scale: 1 },
      transition: CHAT_SPRING_SOFT
    }
  }

  return {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: CHAT_SPRING_SOFT
  }
}

/** Pop used for icon swaps (send arrow, tool-call checkmark). */
export function iconPop(reduced: boolean): EnterMotion {
  if (reduced) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      transition: REDUCED_TRANSITION
    }
  }
  return {
    initial: { opacity: 0, scale: 0.6 },
    animate: { opacity: 1, scale: 1 },
    transition: CHAT_SPRING
  }
}
