import { afterEach, describe, expect, it } from 'vitest'
import { applyColorTheme } from './apply-color-theme'
import { oklchComponentsToHex } from './color-utils'
import { readCssTokenHex } from './read-css-token'
import { getTerminalSearchDecorations } from './terminal-search-decorations'

describe('readCssTokenHex', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('reads an applied theme token as hex', () => {
    applyColorTheme('termul')
    expect(readCssTokenHex('--primary')).toBe(oklchComponentsToHex('0.551 0.188 259.9'))
  })

  it('uses fallback components when the token is missing', () => {
    expect(readCssTokenHex('--foreground', '0.925 0 0')).toBe(oklchComponentsToHex('0.925 0 0'))
  })
})

describe('getTerminalSearchDecorations', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('uses search-match tokens, not hardcoded yellow', () => {
    applyColorTheme('termul')
    const decorations = getTerminalSearchDecorations()
    expect(decorations.matchBackground).toBe(readCssTokenHex('--search-match'))
    expect(decorations.activeMatchBackground).toBe(readCssTokenHex('--search-match-active'))
    expect(decorations.activeMatchBackground).not.toBe('#ffff00')
    expect(decorations.matchBackground).not.toBe('#444444')
  })
})
