import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToOklch, oklchComponentsToHex } from './color-utils'
import {
  PROJECT_COLOR_COMPONENTS,
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
    for (const components of Object.values(PROJECT_COLOR_COMPONENTS)) {
      const [, sourceC, sourceH] = components.split(/\s+/).map(Number)
      const derived = statusBarFillComponents(components)
      const { l, h } = hexToOklch(oklchComponentsToHex(derived))
      expect(l).toBeGreaterThan(STATUS_BAR_FILL_L - 0.02)
      expect(l).toBeLessThan(STATUS_BAR_FILL_L + 0.02)
      expect(l).toBeLessThanOrEqual(0.6)
      expect(hueDelta(h, sourceH)).toBeLessThan(10)
      expect(Number.parseFloat(derived.split(/\s+/)[1] ?? '0')).toBeLessThanOrEqual(sourceC + 0.002)
    }
  })

  it('meets WCAG AA for near-white status-bar ink', () => {
    for (const [color, components] of Object.entries(PROJECT_COLOR_COMPONENTS)) {
      const fill = oklchComponentsToHex(statusBarFillComponents(components))
      expect(contrastRatio(fill, ink), color).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('emits a token for every project colour', () => {
    const vars = statusBarCssVars()
    for (const color of Object.keys(PROJECT_COLOR_COMPONENTS) as Array<
      keyof typeof PROJECT_COLOR_COMPONENTS
    >) {
      expect(vars[`--status-bar-${color}`]).toBe(
        statusBarFillComponents(PROJECT_COLOR_COMPONENTS[color])
      )
    }
  })
})
