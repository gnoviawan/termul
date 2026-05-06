import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const loadAddon = vi.fn()
  const open = vi.fn()
  const onData = vi.fn(() => ({ dispose: vi.fn() }))
  const onResize = vi.fn(() => ({ dispose: vi.fn() }))
  const dispose = vi.fn()
  const write = vi.fn()
  const writeln = vi.fn()
  const clear = vi.fn()
  const focus = vi.fn()
  const blur = vi.fn()
  const scrollToBottom = vi.fn()

  return {
    terminalCtorOptions: [] as unknown[],
    terminalInstances: [] as unknown[],
    loadAddon,
    open,
    onData,
    onResize,
    dispose,
    write,
    writeln,
    clear,
    focus,
    blur,
    scrollToBottom,
    fit: vi.fn(),
    webglOnContextLoss: vi.fn(),
    webglDispose: vi.fn(),
  }
})

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}

    constructor(options: unknown) {
      mocks.terminalCtorOptions.push(options)
      mocks.terminalInstances.push(this)
    }

    loadAddon = mocks.loadAddon
    open = mocks.open
    onData = mocks.onData
    onResize = mocks.onResize
    dispose = mocks.dispose
    write = mocks.write
    writeln = mocks.writeln
    clear = mocks.clear
    focus = mocks.focus
    blur = mocks.blur
    scrollToBottom = mocks.scrollToBottom
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit = mocks.fit
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }))
    dispose = vi.fn()
  },
}))

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class MockSearchAddon {
    findNext = vi.fn()
    findPrevious = vi.fn()
    clearDecorations = vi.fn()
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {
    dispose = vi.fn()
  },
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class MockWebglAddon {
    onContextLoss = mocks.webglOnContextLoss
    dispose = mocks.webglDispose
  },
}))

import {
  createTerminalSession,
  loadWebglAddon,
  shouldUseWebglRenderer,
} from './terminal-factory'

describe('terminal-factory', () => {
  beforeEach(() => {
    mocks.terminalCtorOptions.length = 0
    mocks.terminalInstances.length = 0
    vi.clearAllMocks()
  })

  it('creates a terminal session with fit/search/web-links addons when requested', () => {
    const session = createTerminalSession({
      fontFamily: 'monospace',
      fontSize: 15,
      scrollback: 1234,
      convertEol: true,
      loadSearchAddon: true,
      loadWebLinksAddon: true,
    })

    expect(session.terminal).toBeDefined()
    expect(session.fitAddon).toBeDefined()
    expect(session.searchAddon).toBeDefined()
    expect(session.webLinksAddon).toBeDefined()
    expect(mocks.loadAddon).toHaveBeenCalledTimes(3)
    expect(mocks.terminalCtorOptions[0]).toMatchObject({
      fontFamily: 'monospace',
      fontSize: 15,
      scrollback: 1234,
      convertEol: true,
    })
  })

  it('allows terminal option overrides for shared migration seams', () => {
    createTerminalSession({
      terminalOptions: {
        cursorBlink: false,
        allowTransparency: true,
      },
    })

    expect(mocks.terminalCtorOptions[0]).toMatchObject({
      cursorBlink: false,
      allowTransparency: true,
    })
  })

  it('loads the WebGL addon with a context-loss callback', () => {
    const session = createTerminalSession()
    const onContextLoss = vi.fn()

    const addon = loadWebglAddon(session.terminal, { onContextLoss })

    expect(addon).toBeDefined()
    expect(mocks.webglOnContextLoss).toHaveBeenCalledWith(onContextLoss)
    expect(mocks.loadAddon).toHaveBeenCalled()
  })

  it('uses WebGL only for the webgl preference', () => {
    expect(shouldUseWebglRenderer('webgl')).toBe(true)
    expect(shouldUseWebglRenderer('dom')).toBe(false)
  })
})
