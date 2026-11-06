import { describe, expect, it } from 'vitest'
import baseline from './__fixtures__/theme-output-baseline.json'
import { applyColorTheme, resolveThemeForTest } from './apply-color-theme'
import { BUNDLED_COLOR_THEMES } from './bundled-themes'
import { COMPONENT_TOKEN_DEFAULTS } from './component-tokens'

/**
 * Output captured before the Termul brand move. Every theme other than the
 * two Termul ones must keep rendering exactly as it did, and no theme may
 * change its terminal ANSI or selection colors.
 */
const TERMUL_IDS = new Set(['termul', 'termul-light'])
/** Terminal surface keys follow the chrome ramp, not the brand. */
const SURFACE_KEYS = new Set([
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionForeground',
  'white'
])

const xtermBaseline = baseline.xterm as Record<string, Record<string, string>>
const cssBaseline = baseline.cssVars as Record<string, Record<string, string>>

function emittedVars(themeId: string): Record<string, string> {
  const root = document.documentElement
  root.removeAttribute('style')
  for (const key of Object.keys(root.dataset)) delete root.dataset[key]
  applyColorTheme(themeId)
  const vars: Record<string, string> = {}
  for (let i = 0; i < root.style.length; i++) {
    const name = root.style.item(i)
    vars[name] = root.style.getPropertyValue(name)
  }
  return vars
}

describe('theme output regression', () => {
  it('covers every bundled theme', () => {
    expect(Object.keys(xtermBaseline).sort()).toEqual(Object.keys(BUNDLED_COLOR_THEMES).sort())
  })

  for (const id of Object.keys(xtermBaseline)) {
    it(`${id} keeps its terminal ANSI and selection colors`, () => {
      const { xterm } = resolveThemeForTest(BUNDLED_COLOR_THEMES[id])
      const before = xtermBaseline[id]
      for (const [key, value] of Object.entries(before)) {
        if (TERMUL_IDS.has(id) && SURFACE_KEYS.has(key)) continue
        expect(xterm[key as keyof typeof xterm], `${id} ${key}`).toBe(value)
      }
    })
  }

  for (const id of Object.keys(cssBaseline)) {
    it(`${id} emits the same CSS variables as before`, () => {
      const vars = emittedVars(id)
      for (const [name, value] of Object.entries(cssBaseline[id])) {
        expect(vars[name], `${id} ${name}`).toBe(value)
      }
      for (const [name, value] of Object.entries(COMPONENT_TOKEN_DEFAULTS)) {
        expect(vars[name], `${id} ${name}`).toBe(value)
      }
      expect(document.documentElement.dataset.flatElevation).toBeUndefined()
    })
  }
})
