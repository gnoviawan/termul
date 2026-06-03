import { describe, expect, it } from 'vitest'
import { paletteToXtermTheme, resolveThemeForTest } from './apply-color-theme'
import { BUNDLED_COLOR_THEMES } from './bundled-themes'
import { resolveSyntaxColors } from './resolve-syntax'

describe('apply-color-theme', () => {
  it('includes all v1 bundled themes', () => {
    const ids = Object.keys(BUNDLED_COLOR_THEMES)
    expect(ids).toContain('termul')
    expect(ids).toContain('catppuccin')
    expect(ids).toContain('dracula')
    expect(ids.length).toBeGreaterThanOrEqual(10)
  })

  it('derives syntax colors from catppuccin palette', () => {
    const theme = BUNDLED_COLOR_THEMES.catppuccin
    const syntax = resolveSyntaxColors(theme)
    expect(syntax.keyword).toBe('#cba6f7')
    expect(syntax.string).toBe('#a6e3a1')
  })

  it('maps palette to xterm theme', () => {
    const { xterm } = resolveThemeForTest(BUNDLED_COLOR_THEMES.dracula)
    expect(xterm.background).toBe('#1d1e28')
    expect(xterm.foreground).toBe('#f8f8f2')
    expect(xterm.green).toBe('#50fa7b')
  })

  it('exports paletteToXtermTheme with 16 ansi colors', () => {
    const xterm = paletteToXtermTheme(BUNDLED_COLOR_THEMES.nord.dark.palette)
    expect(xterm.brightBlue).toBeTruthy()
    expect(xterm.brightWhite).toBeTruthy()
  })
})
