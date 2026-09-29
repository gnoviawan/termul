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
    expect(readCssTokenHex('--primary-fill')).toBe(oklchComponentsToHex('0.551 0.188 259.9'))
  })

  it('throws when the token is missing', () => {
    expect(() => readCssTokenHex('--not-a-token')).toThrow('Missing CSS token --not-a-token')
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
