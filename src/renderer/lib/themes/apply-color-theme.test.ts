import { afterEach, describe, expect, it } from 'vitest'
import { applyColorTheme, paletteToXtermTheme, resolveThemeForTest } from './apply-color-theme'
import { BUNDLED_COLOR_THEMES } from './bundled-themes'
import { contrastRatio, oklchComponentsToHex } from './color-utils'
import { resolveSyntaxColors } from './resolve-syntax'

function cssVarToHex(name: string): string {
  return oklchComponentsToHex(document.documentElement.style.getPropertyValue(name))
}

describe('apply-color-theme', () => {
  it('includes dark and light bundled themes', () => {
    const ids = Object.keys(BUNDLED_COLOR_THEMES)
    expect(ids).toContain('termul')
    expect(ids).toContain('termul-light')
    expect(ids).toContain('catppuccin')
    expect(ids).toContain('catppuccin-light')
    expect(ids.length).toBe(20)
  })

  it('derives syntax colors from catppuccin palette', () => {
    const theme = BUNDLED_COLOR_THEMES.catppuccin
    const syntax = resolveSyntaxColors(theme)
    expect(syntax.keyword).toBe('#cba6f7')
    expect(syntax.string).toBe('#a6e3a1')
    expect(syntax.function).toBe('#89b4fa')
  })

  it('separates termul function color from keyword', () => {
    const syntax = resolveSyntaxColors(BUNDLED_COLOR_THEMES.termul)
    expect(syntax.keyword).toBe('#c586c0')
    expect(syntax.function).toBe('#dcdcaa')
  })

  it('maps palette to xterm theme', () => {
    const { xterm } = resolveThemeForTest(BUNDLED_COLOR_THEMES.dracula)
    expect(xterm.background).toBe('#1d1e28')
    expect(xterm.foreground).toBe('#f8f8f2')
    expect(xterm.green).toBe('#50fa7b')
  })

  it('exports paletteToXtermTheme with 16 ansi colors', () => {
    const xterm = paletteToXtermTheme(BUNDLED_COLOR_THEMES.nord.dark.palette, 'dark')
    expect(xterm.brightBlue).toBeTruthy()
    expect(xterm.brightWhite).toBeTruthy()
  })

  it('maps light palette to xterm theme', () => {
    const theme = BUNDLED_COLOR_THEMES['github-light']
    const { xterm } = resolveThemeForTest(theme)
    expect(theme.appearance).toBe('light')
    expect(xterm.background).toBe('#ffffff')
    expect(xterm.foreground).toBe('#24292f')
  })

  describe('text contrast', () => {
    afterEach(() => {
      document.documentElement.removeAttribute('style')
    })

    it.each(
      Object.keys(BUNDLED_COLOR_THEMES)
    )('%s: text-only tokens pass AA on card and secondary', (themeId) => {
      applyColorTheme(themeId)
      for (const token of ['--muted-foreground', '--success', '--warning']) {
        for (const surface of ['--card', '--secondary']) {
          expect(
            contrastRatio(cssVarToHex(token), cssVarToHex(surface)),
            `${token} on ${surface}`
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    })

    it('keeps the terminal palette unchanged', () => {
      const { xterm } = resolveThemeForTest(BUNDLED_COLOR_THEMES['termul-light'])
      expect(xterm.yellow).toBe(BUNDLED_COLOR_THEMES['termul-light'].dark.palette.warning)
    })
  })
})
