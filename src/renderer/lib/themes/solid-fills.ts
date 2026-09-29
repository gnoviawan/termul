import {
  ensureContrast,
  hexToOklch,
  hexToOklchComponents,
  oklchComponentsToHex,
  oklchToHex,
  TEXT_CONTRAST_MIN
} from './color-utils'

/**
 * Max L for a solid fill that carries near-white ink.
 * Above 0.6 the fill reads as a light surface (emil-color cutoff).
 */
export const SOLID_FILL_MAX_L = 0.55

/** Dark ink L on a light fill (warning buttons). Contrast lives in the L gap. */
export const FILL_INK_L = 0.218

const WHITE = '#ffffff'

/** Drop L to the solid-fill step, then darken until white ink meets AA. */
export function solidFillComponents(hex: string): string {
  const { l, c, h } = hexToOklch(hex)
  const clamped = oklchToHex({ l: Math.min(l, SOLID_FILL_MAX_L), c, h })
  return hexToOklchComponents(ensureContrast(clamped, WHITE, TEXT_CONTRAST_MIN))
}

/**
 * Ink on `fillHex`, same hue. Light fills get dark ink; dark fills get light ink.
 * Does not mix toward black/white in sRGB. Shift L only until AA on the emitted fill.
 */
export function fillInkComponents(fillHex: string): string {
  const fill = hexToOklch(fillHex)
  const fillEmitted = oklchComponentsToHex(hexToOklchComponents(fillHex))
  const seedL = fill.l > 0.6 ? FILL_INK_L : 0.98
  return hexToOklchComponents(
    ensureContrast(oklchToHex({ l: seedL, c: fill.c, h: fill.h }), fillEmitted, TEXT_CONTRAST_MIN)
  )
}
