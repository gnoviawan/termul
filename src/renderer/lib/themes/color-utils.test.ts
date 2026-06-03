import { describe, expect, it } from 'vitest'
import {
  hexToHslComponents,
  mixHex,
  normalizeHex,
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

  it('mixes two colors', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('normalizes 3- and 6-digit hex', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc')
    expect(normalizeHex('#E5E5E5')).toBe('#e5e5e5')
  })

  it('strips alpha from 8-digit hex for comparison', () => {
    expect(normalizeHex('#e4e4e45e')).toBe('#e4e4e4')
  })

  it('detects when override differs from base', () => {
    expect(shouldOverrideToken('#9cdcfe', '#e5e5e5')).toBe(true)
    expect(shouldOverrideToken('#e5e5e5', '#E5E5E5')).toBe(false)
  })
})
