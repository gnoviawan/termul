import { describe, expect, it } from 'vitest'
import { BUNDLED_COLOR_THEMES, COLOR_THEME_LIST, getColorThemeDefinition } from './bundled-themes'
import { contrastRatio, hexToOklch, shouldOverrideToken, TEXT_CONTRAST_MIN } from './color-utils'
import { resolveSyntaxColors } from './resolve-syntax'
import { TERMUL_DARK_CHROME } from './termul-dark-chrome'
import { TERMUL_LIGHT_CHROME } from './termul-light-chrome'

const EXPECTED_SYNTAX: Record<
  string,
  Partial<{
    keyword: string
    string: string
    function: string
    variable: string
    property: string
    type: string
  }>
> = {
  termul: {
    keyword: '#d5b2ff',
    string: '#7fe4a5',
    function: '#9dc7fe',
    variable: '#e5e5e6',
    type: '#72dee4'
  },
  cursor: {
    keyword: '#82d2ce',
    string: '#e394dc',
    function: '#efb080',
    property: '#81a1c1'
  },
  catppuccin: {
    keyword: '#cba6f7',
    string: '#a6e3a1',
    function: '#89b4fa',
    type: '#f9e2af'
  },
  dracula: {
    keyword: '#ff79c6',
    string: '#f1fa8c',
    function: '#50fa7b',
    property: '#8be9fd'
  },
  nord: {
    keyword: '#81a1c1',
    string: '#a3be8c',
    function: '#88c0d0',
    type: '#8fbcbb'
  },
  gruvbox: {
    keyword: '#fb4934',
    string: '#b8bb26',
    function: '#83a598'
  },
  tokyonight: {
    keyword: '#bb9af7',
    string: '#9ece6a',
    function: '#7aa2f7',
    property: '#7dcfff'
  },
  ayu: {
    keyword: '#ff8f40',
    string: '#aad94c',
    function: '#ffb454',
    property: '#39bae6'
  },
  'one-dark': {
    keyword: '#c678dd',
    string: '#98c379',
    function: '#61afef',
    variable: '#e06c75',
    property: '#56b6c2'
  },
  github: {
    keyword: '#ff7b72',
    string: '#39c5cf',
    function: '#bc8cff',
    variable: '#d29922',
    property: '#39c5cf'
  },
  'termul-light': {
    keyword: '#753ba8',
    string: '#036a34',
    function: '#0256a9',
    variable: '#0d0d0d',
    type: '#03758e'
  },
  'github-light': {
    keyword: '#cf222e',
    string: '#0969da',
    function: '#8250df'
  }
}

describe('resolveSyntaxColors', () => {
  it.each(
    Object.keys(EXPECTED_SYNTAX).map((themeId) => [themeId] as const)
  )('resolves expected tokens for %s', (themeId) => {
    const theme = BUNDLED_COLOR_THEMES[themeId]
    const syntax = resolveSyntaxColors(theme)
    const expected = EXPECTED_SYNTAX[themeId]
    expect(expected).toBeDefined()

    for (const [key, hex] of Object.entries(expected)) {
      expect(syntax[key as keyof typeof syntax]).toBe(hex)
    }
  })

  it('maps tags from keyword color', () => {
    const syntax = resolveSyntaxColors(BUNDLED_COLOR_THEMES.dracula)
    expect(syntax.tag).toBe(syntax.keyword)
  })

  it('keeps termul tags on the foreground, not the keyword hue', () => {
    const dark = resolveSyntaxColors(BUNDLED_COLOR_THEMES.termul)
    const light = resolveSyntaxColors(BUNDLED_COLOR_THEMES['termul-light'])
    expect(dark.tag).toBe(dark.variable)
    expect(dark.attributeName).toBe(dark.variable)
    expect(light.tag).toBe(light.variable)
    expect(light.attributeName).toBe(light.variable)
  })

  it('keeps termul syntax bright, with gray comments', () => {
    const cases = [
      {
        themeId: 'termul',
        surfaces: [TERMUL_DARK_CHROME.background, TERMUL_DARK_CHROME.card]
      },
      {
        themeId: 'termul-light',
        surfaces: [TERMUL_LIGHT_CHROME.background, TERMUL_LIGHT_CHROME.card]
      }
    ] as const
    const colored = ['keyword', 'string', 'function', 'type', 'number'] as const
    const readable = [...colored, 'comment', 'variable', 'punctuation'] as const

    for (const { themeId, surfaces } of cases) {
      const syntax = resolveSyntaxColors(BUNDLED_COLOR_THEMES[themeId])
      for (const key of readable) {
        for (const surface of surfaces) {
          expect(contrastRatio(syntax[key], surface), `${themeId} ${key}`).toBeGreaterThanOrEqual(
            TEXT_CONTRAST_MIN
          )
        }
      }
      for (const key of colored) {
        expect(hexToOklch(syntax[key]).c, `${themeId} ${key}`).toBeGreaterThanOrEqual(0.09)
      }
      expect(hexToOklch(syntax.comment).c, themeId).toBeLessThan(0.03)
    }
  })

  it('falls back to accent for function when no override', () => {
    const theme = structuredClone(BUNDLED_COLOR_THEMES.github)
    delete theme.dark.overrides!['syntax-function']
    const syntax = resolveSyntaxColors(theme)
    expect(syntax.function).toBe(theme.dark.palette.accent)
  })

  it('does not store redundant variable/property/function overrides', () => {
    for (const theme of COLOR_THEME_LIST) {
      const { palette, overrides = {} } = theme.dark

      const assertDistinct = (token: string | undefined, base: string, label: string) => {
        if (!token || token.replace(/^#/, '').length > 6) return
        expect(shouldOverrideToken(token, base), `${theme.id} ${label}`).toBe(true)
      }

      assertDistinct(overrides['syntax-variable'], palette.ink, 'variable')
      assertDistinct(overrides['syntax-property'], palette.ink, 'property')
      assertDistinct(overrides['syntax-function'], palette.accent, 'function')
    }
  })
})

describe('getColorThemeDefinition', () => {
  it('falls back for unknown ids without prototype pollution', () => {
    const theme = getColorThemeDefinition('toString')
    expect(theme.id).toBe('termul')
  })
})
