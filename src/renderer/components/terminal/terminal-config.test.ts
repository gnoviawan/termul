import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TERMINAL_OPTIONS, getTerminalOptions } from './terminal-config'

describe('getTerminalOptions', () => {
  it('should return windowsPty config for Windows platform', () => {
    const options = getTerminalOptions('Win32')
    expect(options.windowsPty).toEqual({
      backend: 'conpty',
      buildNumber: 21376
    })
    expect(options.convertEol).toBe(false)
    expect(options.ignoreBracketedPasteMode).toBe(false)
  })

  it('should not include windowsPty for macOS platform', () => {
    const options = getTerminalOptions('MacIntel')
    expect(options.windowsPty).toBeUndefined()
    expect(options.convertEol).toBe(false)
    expect(options.ignoreBracketedPasteMode).toBe(false)
  })

  it('should not include windowsPty for Linux platform', () => {
    const options = getTerminalOptions('Linux x86_64')
    expect(options.windowsPty).toBeUndefined()
    expect(options.convertEol).toBe(false)
    expect(options.ignoreBracketedPasteMode).toBe(false)
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
    expect(DEFAULT_TERMINAL_OPTIONS.ignoreBracketedPasteMode).toBe(false)
  })

  it('should have expected default values', () => {
    expect(DEFAULT_TERMINAL_OPTIONS.fontSize).toBe(14)
    expect(DEFAULT_TERMINAL_OPTIONS.scrollback).toBe(10000)
    expect(DEFAULT_TERMINAL_OPTIONS.cursorBlink).toBe(true)
  })

  it('should disable screenReaderMode to avoid duplicate PTY input (#267)', () => {
    expect(DEFAULT_TERMINAL_OPTIONS.screenReaderMode).toBe(false)
  })
})

// L-28: ConnectedTerminal passes AppSettings.terminalScreenReaderMode as the
// constructor option on top of these shipped options. This runs a real xterm
// (no mock) to pin that the option reaches xterm's accessibility tree.
describe('screenReaderMode with a real xterm (L-28)', () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext
  const disposables: Terminal[] = []

  afterEach(() => {
    for (const terminal of disposables.splice(0)) terminal.dispose()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    vi.restoreAllMocks()
  })

  function stubCanvasContext(): void {
    // jsdom has no 2D context; xterm's DOM renderer measures a character cell
    // through measureText on open(). Any other member is a no-op.
    const context = new Proxy(
      { measureText: () => ({ width: 8 }) },
      {
        get: (target, prop) =>
          prop in target ? (target as Record<string | symbol, unknown>)[prop] : () => undefined,
        set: () => true
      }
    )
    HTMLCanvasElement.prototype.getContext = (() =>
      context) as unknown as HTMLCanvasElement['getContext']
  }

  function openTerminal(screenReaderMode: boolean): HTMLElement {
    stubCanvasContext()
    const container = document.createElement('div')
    const terminal = new Terminal({ ...getTerminalOptions('Linux x86_64'), screenReaderMode })
    disposables.push(terminal)
    terminal.open(container)
    return container
  }

  it('builds the .xterm-accessibility tree when screenReaderMode is true', () => {
    const container = openTerminal(true)
    expect(container.querySelector('.xterm-accessibility')).not.toBeNull()
  })

  it('builds no accessibility tree when screenReaderMode is false', () => {
    const container = openTerminal(false)
    expect(container.querySelector('.xterm-accessibility')).toBeNull()
  })
})
