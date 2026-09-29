import { cubicBezier } from 'framer-motion'

/**
 * JS mirror of the `--ease-out` design token (index.css):
 * cubic-bezier(0.23, 1, 0.32, 1). Single source for the transition-polish
 * pass — sidebar/explorer width reveals, pane split layout tweens, and tab
 * FLIP slides all sample this same curve.
 */
export const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1]

/** `EASE_OUT` as an easing function for JS-driven rAF tweens. */
export const easeOutCurve: (t: number) => number = cubicBezier(
  EASE_OUT[0],
  EASE_OUT[1],
  EASE_OUT[2],
  EASE_OUT[3]
)
