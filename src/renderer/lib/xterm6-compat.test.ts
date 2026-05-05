import { describe, expect, it } from 'vitest'
import {
  Xterm6FitAddon,
  Xterm6SearchAddon,
  Xterm6Terminal,
  Xterm6WebglAddon,
  Xterm6WebLinksAddon,
  XTERM_6_PACKAGE_LINE,
} from './xterm6-compat'

describe('xterm6-compat', () => {
  it('resolves xterm 6 constructors from aliased packages', () => {
    expect(typeof Xterm6Terminal).toBe('function')
    expect(typeof Xterm6FitAddon).toBe('function')
    expect(typeof Xterm6SearchAddon).toBe('function')
    expect(typeof Xterm6WebLinksAddon).toBe('function')
    expect(typeof Xterm6WebglAddon).toBe('function')
  })

  it('publishes the evaluated xterm 6 package line', () => {
    expect(XTERM_6_PACKAGE_LINE).toEqual({
      xterm: '6.1.0-beta.215',
      addonFit: '0.12.0-beta.215',
      addonSearch: '0.17.0-beta.215',
      addonWebLinks: '0.13.0-beta.215',
      addonWebgl: '0.20.0-beta.215',
    })
  })
})
