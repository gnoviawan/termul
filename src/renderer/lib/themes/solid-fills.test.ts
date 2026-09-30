import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToOklch, oklchComponentsToHex } from './color-utils'
import { FILL_INK_L, fillInkComponents, SOLID_FILL_MAX_L, solidFillComponents } from './solid-fills'

function hueDelta(a: number, b: number): number {
  return Math.min(Math.abs(a - b), 360 - Math.abs(a - b))
}

describe('solidFillComponents', () => {
  it('keeps C and H and drops L when the source is above the fill step', () => {
    const source = '#3b82f6'
    const { c, h } = hexToOklch(source)
    const derived = hexToOklch(oklchComponentsToHex(solidFillComponents(source)))
    expect(derived.l).toBeLessThanOrEqual(SOLID_FILL_MAX_L + 0.02)
    expect(derived.l).toBeGreaterThan(SOLID_FILL_MAX_L - 0.02)
    expect(Math.abs(derived.c - c)).toBeLessThan(0.02)
    expect(hueDelta(derived.h, h)).toBeLessThan(10)
  })

  it('does not raise L when the source is already at or below the fill step', () => {
    const source = '#0451a5'
    const sourceL = hexToOklch(source).l
    const derived = hexToOklch(oklchComponentsToHex(solidFillComponents(source)))
    expect(derived.l).toBeLessThanOrEqual(sourceL + 0.01)
  })
})

describe('fillInkComponents', () => {
  it('keeps hue and meets AA on the fill', () => {
    const fill = '#eab308'
    const { h } = hexToOklch(fill)
    const inkHex = oklchComponentsToHex(fillInkComponents(fill))
    const ink = hexToOklch(inkHex)
    expect(ink.l).toBeLessThan(0.5)
    expect(hueDelta(ink.h, h)).toBeLessThan(10)
    expect(contrastRatio(inkHex, fill)).toBeGreaterThanOrEqual(4.5)
  })

  it('starts from the fill-ink L step', () => {
    const ink = hexToOklch(oklchComponentsToHex(fillInkComponents('#eab308')))
    expect(ink.l).toBeGreaterThan(FILL_INK_L - 0.05)
  })
})
