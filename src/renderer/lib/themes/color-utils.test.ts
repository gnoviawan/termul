import { describe, expect, it } from 'vitest'
import { hexToHslComponents, mixHex, parseHexColor } from './color-utils'

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
})
