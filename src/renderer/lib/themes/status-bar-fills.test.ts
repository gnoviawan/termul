import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToOklch, oklchComponentsToHex } from './color-utils'
import {
  PROJECT_SWATCHES,
  STATUS_BAR_FILL_L,
  statusBarCssVars,
  statusBarFillComponents
} from './status-bar-fills'

function hueDelta(a: number, b: number): number {
  return Math.min(Math.abs(a - b), 360 - Math.abs(a - b))
}

describe('statusBarFillComponents', () => {
  const ink = oklchComponentsToHex('0.98 0.02 260')

  it('drops L to the chrome-bar step and keeps hue', () => {
    for (const swatch of Object.values(PROJECT_SWATCHES)) {
      const derived = statusBarFillComponents(swatch)
      const { l, h } = hexToOklch(oklchComponentsToHex(derived))
      expect(l).toBeGreaterThan(STATUS_BAR_FILL_L - 0.02)
      expect(l).toBeLessThan(STATUS_BAR_FILL_L + 0.02)
      expect(l).toBeLessThanOrEqual(0.6)
      expect(hueDelta(h, swatch.h)).toBeLessThan(10)
      expect(Number.parseFloat(derived.split(/\s+/)[1] ?? 'NaN')).toBeLessThanOrEqual(
        swatch.c + 0.002
      )
    }
  })

  it('meets WCAG AA for near-white status-bar ink', () => {
    for (const [color, swatch] of Object.entries(PROJECT_SWATCHES)) {
      const fill = oklchComponentsToHex(statusBarFillComponents(swatch))
      expect(contrastRatio(fill, ink), color).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('emits a token for every project colour', () => {
    const vars = statusBarCssVars()
    for (const color of Object.keys(PROJECT_SWATCHES) as Array<keyof typeof PROJECT_SWATCHES>) {
      expect(vars[`--status-bar-${color}`]).toBe(statusBarFillComponents(PROJECT_SWATCHES[color]))
    }
  })
})
