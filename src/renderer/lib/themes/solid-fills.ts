import {
  contrastRatio,
  ensureContrast,
  hexToOklch,
  hexToOklchComponents,
  oklchComponentsToHex,
  oklchToHex
} from './color-utils'

/**
 * Max L for a solid fill that carries near-white ink.
 * Above 0.6 the fill reads as a light surface (emil-color cutoff).
 */
export const SOLID_FILL_MAX_L = 0.55

/** Dark ink L on a light fill (warning buttons). Contrast lives in the L gap. */
export const FILL_INK_L = 0.218

const WHITE = '#ffffff'
const TEXT_CONTRAST_MIN = 4.5

/** Drop L to the solid-fill step. C and H stay; chroma may clamp to sRGB. */
export function solidFillComponents(hex: string): string {
  const { l, c, h } = hexToOklch(hex)
  let nextL = Math.min(l, SOLID_FILL_MAX_L)
  let components = hexToOklchComponents(oklchToHex({ l: nextL, c, h }))
  for (let i = 0; i < 40; i++) {
    if (contrastRatio(oklchComponentsToHex(components), WHITE) >= TEXT_CONTRAST_MIN) break
    if (nextL <= 0.3) break
    nextL -= 0.01
    components = hexToOklchComponents(oklchToHex({ l: nextL, c, h }))
  }
  return components
}

/**
 * Ink on `fillHex`, same hue. Light fills get dark ink; dark fills get light ink.
 * Does not mix toward black/white in sRGB. Shift L only until AA on the emitted pair.
 */
export function fillInkComponents(fillHex: string): string {
  const fill = hexToOklch(fillHex)
  const fillEmitted = oklchComponentsToHex(hexToOklchComponents(fillHex))
  const seedL = fill.l > 0.6 ? FILL_INK_L : 0.98
  const step = fill.l > 0.6 ? -0.01 : 0.01
  let components = hexToOklchComponents(
    ensureContrast(oklchToHex({ l: seedL, c: fill.c, h: fill.h }), fillHex, TEXT_CONTRAST_MIN)
  )
  for (let i = 0; i < 40; i++) {
    if (contrastRatio(oklchComponentsToHex(components), fillEmitted) >= TEXT_CONTRAST_MIN) break
    const ink = hexToOklch(oklchComponentsToHex(components))
    const nextL = ink.l + step
    if (nextL <= 0.02 || nextL >= 0.99) break
    components = hexToOklchComponents(oklchToHex({ ...ink, l: nextL }))
  }
  return components
}
