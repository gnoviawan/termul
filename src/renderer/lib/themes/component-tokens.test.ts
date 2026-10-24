import { afterEach, describe, expect, it } from 'vitest'
import { applyColorTheme } from './apply-color-theme'
import { BUNDLED_COLOR_THEMES } from './bundled-themes'
import { COMPONENT_TOKEN_DEFAULTS } from './component-tokens'
import { CONTAINER, S_DEFAULT } from './termul-light-chrome'

/** Tokens added for the Termul Light v2 composer, keycaps and Rail keycap. */
const LIFT_TOKENS = [
  '--composer-shadow',
  '--prompt-panel-shadow',
  '--keycap-fill',
  '--keycap-shadow',
  '--rail-keycap-fill',
  '--rail-keycap-shadow'
] as const

function emittedVars(themeId: string): Record<string, string> {
  const root = document.documentElement
  root.removeAttribute('style')
  applyColorTheme(themeId)
  const vars: Record<string, string> = {}
  for (let i = 0; i < root.style.length; i++) {
    const name = root.style.item(i)
    vars[name] = root.style.getPropertyValue(name).trim()
  }
  return vars
}

describe('component tokens', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style')
  })

  it('never defaults a shadow token to none', () => {
    // Tailwind joins shadow-* with ring-* into one box-shadow list; `none`
    // inside that list invalidates it and drops the focus ring.
    const shadows = Object.entries(COMPONENT_TOKEN_DEFAULTS).filter(([name]) =>
      /shadow|elevation/.test(name)
    )
    expect(shadows.length).toBeGreaterThan(0)
    for (const [name, value] of shadows) {
      expect(value, name).not.toMatch(/\bnone\b/)
    }
  })

  it('lifts the composer, tabs, keycaps and Rail keycap in Termul Light', () => {
    const vars = emittedVars('termul-light')
    expect(vars['--composer-shadow']).toBe(S_DEFAULT)
    expect(vars['--prompt-panel-shadow']).toBe(S_DEFAULT)
    expect(vars['--keycap-fill']).toBe(CONTAINER)
    expect(vars['--keycap-shadow']).toBe(S_DEFAULT)
    expect(vars['--rail-keycap-shadow']).toBe(S_DEFAULT)
    expect(vars['--rail-keycap-fill']).toBe(CONTAINER)
  })

  for (const id of Object.keys(BUNDLED_COLOR_THEMES).filter((id) => id !== 'termul-light')) {
    it(`${id} keeps the composer and keycap defaults`, () => {
      const vars = emittedVars(id)
      for (const token of LIFT_TOKENS) {
        expect(vars[token], `${id} ${token}`).toBe(COMPONENT_TOKEN_DEFAULTS[token])
      }
    })
  }

  it('emits the --focus-ring token in every bundled theme', () => {
    for (const id of Object.keys(BUNDLED_COLOR_THEMES)) {
      expect(emittedVars(id)['--focus-ring'], id).toBe(COMPONENT_TOKEN_DEFAULTS['--focus-ring'])
    }
  })
})
