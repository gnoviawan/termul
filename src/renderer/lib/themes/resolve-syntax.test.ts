import { describe, expect, it } from 'vitest'
import { BUNDLED_COLOR_THEMES, getColorThemeDefinition } from './bundled-themes'
import { resolveSyntaxColors } from './resolve-syntax'

describe('resolveSyntaxColors', () => {
  it('uses accent for functions when only keyword override is set', () => {
    const syntax = resolveSyntaxColors(BUNDLED_COLOR_THEMES.github)
    expect(syntax.keyword).toBe('#ff7b72')
    expect(syntax.function).toBe('#f78166')
  })

  it('uses primary for tags when only keyword override is set', () => {
    const syntax = resolveSyntaxColors(BUNDLED_COLOR_THEMES.github)
    expect(syntax.tag).toBe('#58a6ff')
  })
})

describe('getColorThemeDefinition', () => {
  it('falls back for unknown ids without prototype pollution', () => {
    const theme = getColorThemeDefinition('toString')
    expect(theme.id).toBe('termul')
  })
})
