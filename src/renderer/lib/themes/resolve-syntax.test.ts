import { describe, expect, it } from 'vitest'
import { BUNDLED_COLOR_THEMES, COLOR_THEME_LIST, getColorThemeDefinition } from './bundled-themes'
import { shouldOverrideToken } from './color-utils'
import { resolveSyntaxColors } from './resolve-syntax'

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
    keyword: '#c586c0',
    string: '#ce9178',
    function: '#dcdcaa',
    variable: '#9cdcfe'
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
    keyword: '#0000ff',
    string: '#a31515',
    function: '#795e26',
    variable: '#001080'
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

  it('falls back to accent for function when no override', () => {
    const theme = structuredClone(BUNDLED_COLOR_THEMES.github)
    delete theme.dark.overrides!['syntax-function']
    const syntax = resolveSyntaxColors(theme)
    expect(syntax.function).toBe(theme.dark.palette.accent)
  })

  it('does not store redundant variable/property/function overrides', () => {
    for (const theme of COLOR_THEME_LIST) {
      const { palette, overrides = {} } = theme.dark
      const keyword = overrides['syntax-keyword'] ?? palette.primary

      const assertDistinct = (token: string | undefined, base: string, label: string) => {
        if (!token || token.replace(/^#/, '').length > 6) return
        expect(shouldOverrideToken(token, base), `${theme.id} ${label}`).toBe(true)
      }

      assertDistinct(overrides['syntax-variable'], palette.ink, 'variable')
      assertDistinct(overrides['syntax-property'], palette.ink, 'property')
      assertDistinct(overrides['syntax-function'], keyword, 'function')
    }
  })
})

describe('getColorThemeDefinition', () => {
  it('falls back for unknown ids without prototype pollution', () => {
    const theme = getColorThemeDefinition('toString')
    expect(theme.id).toBe('termul')
  })
})
