import { describe, it, expect } from 'vitest'
import { getTerminalOptions, DEFAULT_TERMINAL_OPTIONS } from './terminal-config'

describe('getTerminalOptions', () => {
  it('should return windowsPty config for Windows platform', () => {
    const options = getTerminalOptions('Win32')
    expect(options.windowsPty).toEqual({
      backend: 'conpty',
      buildNumber: 21376
    })
    expect(options.convertEol).toBe(false)
  })

  it('should not include windowsPty for macOS platform', () => {
    const options = getTerminalOptions('MacIntel')
    expect(options.windowsPty).toBeUndefined()
    expect(options.convertEol).toBe(false)
  })

  it('should not include windowsPty for Linux platform', () => {
    const options = getTerminalOptions('Linux x86_64')
    expect(options.windowsPty).toBeUndefined()
    expect(options.convertEol).toBe(false)
  })

  it('should include base terminal options for all platforms', () => {
    const windowsOptions = getTerminalOptions('Win32')
    const macOptions = getTerminalOptions('MacIntel')

    // Both should have base options
    expect(windowsOptions.cursorBlink).toBe(true)
    expect(windowsOptions.cursorStyle).toBe('block')
    expect(macOptions.cursorBlink).toBe(true)
    expect(macOptions.cursorStyle).toBe('block')
  })
})

describe('DEFAULT_TERMINAL_OPTIONS', () => {
  it('should have convertEol set to false', () => {
    expect(DEFAULT_TERMINAL_OPTIONS.convertEol).toBe(false)
  })

  it('should have expected default values', () => {
    expect(DEFAULT_TERMINAL_OPTIONS.fontSize).toBe(14)
    expect(DEFAULT_TERMINAL_OPTIONS.scrollback).toBe(10000)
    expect(DEFAULT_TERMINAL_OPTIONS.cursorBlink).toBe(true)
  })
})
