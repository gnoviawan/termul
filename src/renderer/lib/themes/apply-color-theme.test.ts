import { afterEach, describe, expect, it } from 'vitest'
import {
  applyColorTheme,
  paletteToXtermTheme,
  resolveThemeForTest,
  TEXT_TOKENS
} from './apply-color-theme'
import { BUNDLED_COLOR_THEMES } from './bundled-themes'
import { contrastRatio, hexToOklchComponents, oklchComponentsToHex } from './color-utils'
import { resolveSyntaxColors } from './resolve-syntax'
import { PROJECT_COLOR_COMPONENTS } from './status-bar-fills'

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
    expect(xterm.foreground).toBe('#24292f')
  })

  describe('terminal grid surface', () => {
    afterEach(() => {
      document.documentElement.removeAttribute('style')
    })

    it.each(
      Object.keys(BUNDLED_COLOR_THEMES)
    )('%s: xterm background matches --background and --terminal-bg', (themeId) => {
      applyColorTheme(themeId)
      const theme = BUNDLED_COLOR_THEMES[themeId]
      const xterm = paletteToXtermTheme(theme.dark.palette, theme.appearance)
      expect(xterm.background).toBe(cssVarToHex('--terminal-bg'))
      expect(xterm.background).toBe(cssVarToHex('--background'))
      expect(xterm.cursorAccent).toBe(xterm.background)
      expect(xterm.background).not.toBe('#000000')
    })

    it('does not use raw Termul dark palette.neutral for the grid', () => {
      applyColorTheme('termul')
      const { xterm } = resolveThemeForTest(BUNDLED_COLOR_THEMES.termul)
      expect(xterm.background).not.toBe('#121212')
    })
  })

  describe('text contrast', () => {
    afterEach(() => {
      document.documentElement.removeAttribute('style')
    })

    it.each(
      Object.keys(BUNDLED_COLOR_THEMES)
    )('%s: text-only tokens pass AA on card and secondary', (themeId) => {
      applyColorTheme(themeId)
      for (const token of TEXT_TOKENS) {
        for (const surface of ['--card', '--secondary']) {
          expect(
            contrastRatio(cssVarToHex(token), cssVarToHex(surface)),
            `${token} on ${surface}`
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    })

    it.each(
      Object.keys(BUNDLED_COLOR_THEMES)
    )('%s: solid fills carry near-white ink at AA', (themeId) => {
      applyColorTheme(themeId)
      const ink = cssVarToHex('--primary-foreground')
      const white = cssVarToHex('--success-foreground')
      expect(
        contrastRatio(cssVarToHex('--primary'), ink),
        `${themeId} primary`
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(cssVarToHex('--success-fill'), white),
        `${themeId} success-fill`
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastRatio(cssVarToHex('--destructive-fill'), white),
        `${themeId} destructive-fill`
      ).toBeGreaterThanOrEqual(4.5)
    })

    it.each(
      Object.keys(BUNDLED_COLOR_THEMES)
    )('%s: warning ink meets AA on the warning fill', (themeId) => {
      applyColorTheme(themeId)
      expect(
        contrastRatio(cssVarToHex('--warning-foreground'), cssVarToHex('--warning')),
        themeId
      ).toBeGreaterThanOrEqual(4.5)
    })

    it.each(
      Object.keys(BUNDLED_COLOR_THEMES)
    )('%s: disabled ink meets 3:1 on muted, card, and secondary', (themeId) => {
      applyColorTheme(themeId)
      const ink = cssVarToHex('--disabled-foreground')
      for (const surface of ['--muted', '--card', '--secondary']) {
        expect(
          contrastRatio(ink, cssVarToHex(surface)),
          `${themeId} ${surface}`
        ).toBeGreaterThanOrEqual(3)
      }
    })

    it('keeps the terminal palette unchanged', () => {
      const { xterm } = resolveThemeForTest(BUNDLED_COLOR_THEMES['termul-light'])
      expect(xterm.yellow).toBe(BUNDLED_COLOR_THEMES['termul-light'].dark.palette.warning)
    })
  })

  describe('diff and glow tokens', () => {
    afterEach(() => {
      document.documentElement.removeAttribute('style')
    })

    it.each(
      Object.keys(BUNDLED_COLOR_THEMES)
    )('%s: emits diff-added and glow tokens', (themeId) => {
      applyColorTheme(themeId)
      for (const token of [
        '--diff-added',
        '--diff-added-foreground',
        '--diff-added-border',
        '--glow-green',
        '--glow-blue',
        '--glow-purple'
      ]) {
        expect(
          document.documentElement.style.getPropertyValue(token).trim(),
          `${themeId} ${token}`
        ).not.toBe('')
      }
    })

    it('emits the canonical chat-code-path green for every theme', () => {
      for (const themeId of Object.keys(BUNDLED_COLOR_THEMES)) {
        applyColorTheme(themeId)
        expect(cssVarToHex('--diff-added')).toBe(oklchComponentsToHex('0.72 0.192 149.5'))
        expect(cssVarToHex('--glow-green')).toBe(oklchComponentsToHex('0.72 0.192 149.5'))
      }
    })
  })

  describe('scrollbar and search tokens', () => {
    afterEach(() => {
      document.documentElement.removeAttribute('style')
    })

    it('emits dark scrollbar alphas for termul', () => {
      applyColorTheme('termul')
      expect(document.documentElement.style.getPropertyValue('--scrollbar-thumb-alpha')).toBe('0.4')
      expect(document.documentElement.style.getPropertyValue('--terminal-scrollbar-alpha')).toBe(
        '0.15'
      )
    })

    it('emits light scrollbar alphas for termul-light', () => {
      applyColorTheme('termul-light')
      expect(document.documentElement.style.getPropertyValue('--scrollbar-thumb-alpha')).toBe(
        '0.75'
      )
      expect(document.documentElement.style.getPropertyValue('--terminal-scrollbar-alpha')).toBe(
        '0.25'
      )
    })

    it('emits search-match tokens for termul', () => {
      applyColorTheme('termul')
      expect(document.documentElement.style.getPropertyValue('--search-match').trim()).not.toBe('')
      expect(cssVarToHex('--search-match-active')).toBe(cssVarToHex('--warning'))
    })

    it('emits overlay as black for every appearance', () => {
      applyColorTheme('termul')
      expect(document.documentElement.style.getPropertyValue('--overlay').trim()).toBe('0 0 0')
      applyColorTheme('termul-light')
      expect(document.documentElement.style.getPropertyValue('--overlay').trim()).toBe('0 0 0')
    })

    it('emits Termul dark connection from palette info, not the CSS cyan fallback', () => {
      applyColorTheme('termul')
      expect(cssVarToHex('--connection')).toBe(
        oklchComponentsToHex(hexToOklchComponents(BUNDLED_COLOR_THEMES.termul.dark.palette.info))
      )
    })

    it('emits the dark diff-added-foreground on Termul dark', () => {
      applyColorTheme('termul')
      expect(cssVarToHex('--diff-added-foreground')).toBe(oklchComponentsToHex('0.786 0.138 154'))
    })
  })

  describe('status-bar project fills', () => {
    afterEach(() => {
      document.documentElement.removeAttribute('style')
    })

    it('emits a darker fill for every project colour', () => {
      applyColorTheme('termul')
      for (const color of Object.keys(PROJECT_COLOR_COMPONENTS)) {
        expect(
          document.documentElement.style.getPropertyValue(`--status-bar-${color}`).trim()
        ).not.toBe('')
      }
    })

    it.each([
      'termul',
      'termul-light'
    ])('%s: project status-bar fills pass AA against primary-foreground', (themeId) => {
      applyColorTheme(themeId)
      const ink = cssVarToHex('--primary-foreground')
      for (const color of Object.keys(PROJECT_COLOR_COMPONENTS)) {
        expect(
          contrastRatio(cssVarToHex(`--status-bar-${color}`), ink),
          `${themeId} --status-bar-${color}`
        ).toBeGreaterThanOrEqual(4.5)
      }
    })
  })
})
