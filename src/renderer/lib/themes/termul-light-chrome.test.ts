import { describe, expect, it } from 'vitest'
import { BUNDLED_COLOR_THEMES } from './bundled-themes'
import { contrastRatio, hexToOklchComponents, oklchComponentsToHex } from './color-utils'
import { TERMUL_LIGHT_CHROME } from './termul-light-chrome'

function emitted(hex: string): string {
  return oklchComponentsToHex(hexToOklchComponents(hex))
}

describe('termul light chrome', () => {
  it('uses paper, mist, graphite ink, and a hairline border', () => {
    expect(emitted(TERMUL_LIGHT_CHROME.background)).toBe('#ffffff')
    expect(emitted(TERMUL_LIGHT_CHROME.card)).toBe('#ffffff')
    expect(emitted(TERMUL_LIGHT_CHROME.sidebar ?? '')).toBe('#f9f9f9')
    expect(emitted(TERMUL_LIGHT_CHROME.foreground)).toBe('#0d0d0d')
    expect(emitted(TERMUL_LIGHT_CHROME.border)).toBe('#e5e5e5')
    expect(emitted(TERMUL_LIGHT_CHROME.secondary ?? '')).toBe('#f2f2f2')
    expect(TERMUL_LIGHT_CHROME.flatElevation).toBe(true)
  })

  it('keeps ink and ash readable on paper', () => {
    expect(
      contrastRatio(TERMUL_LIGHT_CHROME.foreground, TERMUL_LIGHT_CHROME.background)
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      contrastRatio(TERMUL_LIGHT_CHROME.secondaryForeground, TERMUL_LIGHT_CHROME.background)
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('is attached only to Termul light and keeps the current blue', () => {
    expect(BUNDLED_COLOR_THEMES['termul-light'].dark.chrome).toEqual(TERMUL_LIGHT_CHROME)
    expect(BUNDLED_COLOR_THEMES['termul-light'].dark.palette.primary).toBe('#3b82f6')
    expect(BUNDLED_COLOR_THEMES['termul-light'].dark.palette.success).toBe('#098658')
    expect(BUNDLED_COLOR_THEMES['termul-light'].dark.palette.warning).toBe('#cd9731')
    expect(BUNDLED_COLOR_THEMES['termul-light'].dark.palette.error).toBe('#cd3131')
    expect(BUNDLED_COLOR_THEMES['github-light'].dark.chrome).toBeUndefined()
    expect(BUNDLED_COLOR_THEMES.termul.dark.chrome?.flatElevation).toBeUndefined()
  })
})
