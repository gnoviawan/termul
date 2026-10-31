import { describe, expect, it } from 'vitest'
import { BUNDLED_COLOR_THEMES } from './bundled-themes'
import { contrastRatio, hexToOklchComponents, oklchComponentsToHex } from './color-utils'
import { TERMUL_LIGHT_CHROME } from './termul-light-chrome'

function emitted(hex: string): string {
  return oklchComponentsToHex(hexToOklchComponents(hex))
}

/** Flatten a black `oklch(0 0 0 / a)` wash onto a grey surface, as the browser composites it. */
function blackWashOn(wash: string, surface: string): string {
  const alpha = Number(/^oklch\(0 0 0 \/ ([\d.]+)\)$/.exec(wash)?.[1])
  expect(alpha, wash).toBeGreaterThan(0)
  const channel = Math.round(Number.parseInt(surface.slice(1, 3), 16) * (1 - alpha))
  return `#${channel.toString(16).padStart(2, '0').repeat(3)}`
}

describe('termul light chrome', () => {
  it('uses the Interfere gray ramp', () => {
    expect(emitted(TERMUL_LIGHT_CHROME.background)).toBe('#fcfcfc')
    expect(emitted(TERMUL_LIGHT_CHROME.card)).toBe('#ffffff')
    expect(emitted(TERMUL_LIGHT_CHROME.sidebar ?? '')).toBe('#f6f6f6')
    expect(emitted(TERMUL_LIGHT_CHROME.foreground)).toBe('#202020')
    expect(emitted(TERMUL_LIGHT_CHROME.border)).toBe('#ededed')
    expect(emitted(TERMUL_LIGHT_CHROME.input ?? '')).toBe('#d9d9d9')
    expect(emitted(TERMUL_LIGHT_CHROME.secondary ?? '')).toBe('#f0f0f0')
    expect(emitted(TERMUL_LIGHT_CHROME.mutedForeground)).toBe('#646464')
  })

  it('carries elevation in shadows instead of a flat override', () => {
    const tokens = TERMUL_LIGHT_CHROME.tokens ?? {}
    expect(tokens['--elevation-sm']).toContain('0 0 0 0.5px #0000000f')
    expect(tokens['--elevation-lg']).toContain('0 3px 12px -4px #0000001a')
    expect(tokens['--elevation-2xl']).toContain('0 12px 32px -16px #00000026')
    expect(tokens['--skeleton']).toBe('#00000017')
    expect(TERMUL_LIGHT_CHROME).not.toHaveProperty('flatElevation')
  })

  it('keeps ink and ash readable on paper', () => {
    expect(
      contrastRatio(TERMUL_LIGHT_CHROME.foreground, TERMUL_LIGHT_CHROME.background)
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      contrastRatio(TERMUL_LIGHT_CHROME.secondaryForeground, TERMUL_LIGHT_CHROME.background)
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('gives the off switch a 3:1 boundary on every Light surface (WCAG 1.4.11)', () => {
    const tokens = TERMUL_LIGHT_CHROME.tokens ?? {}
    const surfaces = ['#ffffff', '#fcfcfc', '#f6f6f6', '#f2f2f2', '#f0f0f0']
    for (const name of [
      '--switch-track-off',
      '--switch-track-off-hover',
      '--switch-track-off-active'
    ] as const) {
      for (const surface of surfaces) {
        const track = blackWashOn(tokens[name] ?? '', surface)
        expect(contrastRatio(track, surface), `${name} on ${surface}`).toBeGreaterThanOrEqual(3)
        expect(contrastRatio(track, '#ffffff'), `${name} thumb`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('is attached only to Termul light and uses the brand blue', () => {
    expect(BUNDLED_COLOR_THEMES['termul-light'].dark.chrome).toEqual(TERMUL_LIGHT_CHROME)
    expect(BUNDLED_COLOR_THEMES['termul-light'].dark.palette.primary).toBe('#0d74ce')
    expect(BUNDLED_COLOR_THEMES['termul-light'].dark.palette.success).toBe('#098658')
    expect(BUNDLED_COLOR_THEMES['termul-light'].dark.palette.warning).toBe('#cd9731')
    expect(BUNDLED_COLOR_THEMES['termul-light'].dark.palette.error).toBe('#cd3131')
    expect(BUNDLED_COLOR_THEMES['github-light'].dark.chrome).toBeUndefined()
    expect(BUNDLED_COLOR_THEMES.termul.dark.chrome?.input).toBeUndefined()
  })
})
