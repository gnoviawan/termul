import { describe, expect, it } from 'vitest'
import {
  contrastRatio,
  ensureContrast,
  hexToHslComponents,
  hexToOklch,
  hslComponentsToHex,
  mixHex,
  normalizeHex,
  oklchToHex,
  parseHexColor,
  shouldOverrideToken
} from './color-utils'

describe('color-utils', () => {
  it('parses 6-digit hex', () => {
    expect(parseHexColor('#3b82f6')).toEqual({ r: 59, g: 130, b: 246 })
  })

  it('parses 3-digit hex', () => {
    expect(parseHexColor('#fff')).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('converts blue hex to hsl components', () => {
    expect(hexToHslComponents('#3b82f6')).toBe('217 91% 60%')
  })

  it('converts hsl components back to hex', () => {
    expect(hslComponentsToHex('0 0% 100%')).toBe('#ffffff')
    expect(hslComponentsToHex('217 91% 60%')).toBe('#3c83f6')
  })

  it('mixes two colors', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('normalizes 3- and 6-digit hex', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc')
    expect(normalizeHex('#E5E5E5')).toBe('#e5e5e5')
  })

  it('rejects malformed hex values', () => {
    expect(() => parseHexColor('#12zzzz')).toThrow('Invalid hex color')
    expect(() => normalizeHex('#e4e4e45e')).toThrow('Invalid hex color')
  })

  it('computes WCAG contrast ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5)
  })

  it('round-trips hex through oklch', () => {
    for (const hex of ['#3b82f6', '#ef4444', '#22c55e', '#e5e5e5', '#121212']) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex)
    }
  })

  it('keeps lightness and hue when clamping out-of-gamut chroma', () => {
    const out = hexToOklch(oklchToHex({ l: 0.7, c: 0.4, h: 150 }))
    expect(out.l).toBeCloseTo(0.7, 2)
    expect(out.h).toBeCloseTo(150, 0)
    expect(out.c).toBeLessThan(0.4)
  })

  it('returns the color unchanged when contrast already passes', () => {
    expect(ensureContrast('#E5E5E5', '#1c1c1c', 4.5)).toBe('#e5e5e5')
  })

  it('lightens text on a dark surface until it reaches the ratio', () => {
    const fixed = ensureContrast('#7c7c7c', '#2a2a2a', 4.5)
    expect(contrastRatio(fixed, '#2a2a2a')).toBeGreaterThanOrEqual(4.5)
    expect(hexToOklch(fixed).l).toBeGreaterThan(hexToOklch('#7c7c7c').l)
  })

  it('darkens text on a light surface and keeps its hue', () => {
    const fixed = ensureContrast('#eab308', '#f5f5f5', 4.5)
    expect(contrastRatio(fixed, '#f5f5f5')).toBeGreaterThanOrEqual(4.5)
    expect(hexToOklch(fixed).h).toBeCloseTo(hexToOklch('#eab308').h, -1)
  })

  it('detects when override differs from base', () => {
    expect(shouldOverrideToken('#9cdcfe', '#e5e5e5')).toBe(true)
    expect(shouldOverrideToken('#e5e5e5', '#E5E5E5')).toBe(false)
  })
})
