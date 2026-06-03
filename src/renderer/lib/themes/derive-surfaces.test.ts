import { describe, expect, it } from 'vitest'
import { BUNDLED_COLOR_THEMES } from './bundled-themes'
import { normalizeHex } from './color-utils'
import { deriveSurfaces } from './derive-surfaces'

describe('deriveSurfaces', () => {
  it('lightens surfaces for dark appearance', () => {
    const palette = BUNDLED_COLOR_THEMES.termul.dark.palette
    const surfaces = deriveSurfaces(palette, 'dark')
    expect(normalizeHex(surfaces.card)).not.toBe(normalizeHex(palette.neutral))
  })

  it('darkens surfaces for light appearance', () => {
    const palette = BUNDLED_COLOR_THEMES['termul-light'].dark.palette
    const surfaces = deriveSurfaces(palette, 'light')
    expect(normalizeHex(surfaces.border)).not.toBe(normalizeHex(palette.neutral))
  })
})
