/**
 * Tailwind's two-stop linear gradients (`bg-gradient-to-l from-x from-60%
 * to-transparent`) as GPUIX's structured `background`. Like Tailwind's
 * `--tw-gradient-*` properties, the direction and each stop come from
 * separate utilities and are combined once per state.
 */
import type { StyleDesc } from '@gpuix/react'
import { formatColor, type Rgba } from './css-value'

export interface GradientParts {
  /** CSS angle in degrees: 0 points up, clockwise. */
  angle?: number
  from?: Rgba
  /** 0..1 along the gradient line. */
  fromAt?: number
  to?: Rgba
  toAt?: number
}

/** `bg-gradient-to-<side>` / `bg-linear-to-<side>`. A corner is taken as its 45° diagonal. */
export const GRADIENT_SIDES: Readonly<Record<string, number>> = {
  t: 0,
  tr: 45,
  r: 90,
  br: 135,
  b: 180,
  bl: 225,
  l: 270,
  tl: 315
}

const CLEAR: Rgba = { r: 0, g: 0, b: 0, a: 0 }

/**
 * CSS interpolates stops in premultiplied alpha, so fading to transparent
 * black fades the other stop's colour. GPUI interpolates the channels as
 * given, so a fully transparent stop takes the other stop's colour at alpha 0.
 */
function clearOf(stop: Rgba, other: Rgba): Rgba {
  return stop.a === 0 ? { ...other, a: 0 } : stop
}

export function gradientBackground(parts: GradientParts): StyleDesc['background'] | undefined {
  if (parts.angle === undefined || (!parts.from && !parts.to)) return undefined
  const from = parts.from ?? CLEAR
  const to = parts.to ?? CLEAR
  return {
    type: 'linear-gradient',
    angle: parts.angle,
    stops: [
      { color: formatColor(clearOf(from, to)), position: parts.fromAt ?? 0 },
      { color: formatColor(clearOf(to, from)), position: parts.toAt ?? 1 }
    ],
    colorSpace: 'oklab'
  }
}
