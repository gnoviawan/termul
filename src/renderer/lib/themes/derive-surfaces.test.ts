import { describe, expect, it } from 'vitest'
import { BUNDLED_COLOR_THEMES } from './bundled-themes'
import { normalizeHex, parseHexColor } from './color-utils'
import { deriveSurfaces } from './derive-surfaces'

function lightness(hex: string): number {
  const { r, g, b } = parseHexColor(normalizeHex(hex))
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return (max + min) / 2
}

describe('deriveSurfaces', () => {
  it('lightens surfaces for dark appearance', () => {
    const palette = BUNDLED_COLOR_THEMES.termul.dark.palette
    const surfaces = deriveSurfaces(palette, 'dark')
    expect(lightness(surfaces.card)).toBeGreaterThan(lightness(palette.neutral))
  })

  it('darkens surfaces for light appearance', () => {
    const palette = BUNDLED_COLOR_THEMES['termul-light'].dark.palette
    const surfaces = deriveSurfaces(palette, 'light')
    expect(lightness(surfaces.border)).toBeLessThan(lightness(palette.neutral))
  })
})
