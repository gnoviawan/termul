import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'

const mocks = vi.hoisted(() => {
  const mockTerminalInstance = {
    loadAddon: vi.fn(),
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    writeln: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    scrollToBottom: vi.fn(),
    dispose: vi.fn(),
    cols: 80,
    rows: 24
  }

  const mockFitAddonInstance = {
    fit: vi.fn(),
    dispose: vi.fn()
  }

  const mockWebglAddonInstance = {
    onContextLoss: vi.fn(),
    dispose: vi.fn()
  }

  const mockWebLinksAddonInstance = {
    dispose: vi.fn()
  }

  return {
    mockTerminalInstance,
    mockFitAddonInstance,
    mockWebglAddonInstance,
    mockWebLinksAddonInstance
  }
})

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    loadAddon = mocks.mockTerminalInstance.loadAddon
    open = mocks.mockTerminalInstance.open
    onData = mocks.mockTerminalInstance.onData
    onResize = mocks.mockTerminalInstance.onResize
    write = mocks.mockTerminalInstance.write
    writeln = mocks.mockTerminalInstance.writeln
    clear = mocks.mockTerminalInstance.clear
    focus = mocks.mockTerminalInstance.focus
    blur = mocks.mockTerminalInstance.blur
    scrollToBottom = mocks.mockTerminalInstance.scrollToBottom
    dispose = mocks.mockTerminalInstance.dispose
    cols = mocks.mockTerminalInstance.cols
    rows = mocks.mockTerminalInstance.rows
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit = mocks.mockFitAddonInstance.fit
    dispose = mocks.mockFitAddonInstance.dispose
  }
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class MockWebglAddon {
    onContextLoss = mocks.mockWebglAddonInstance.onContextLoss
    dispose = mocks.mockWebglAddonInstance.dispose
  }
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {
    dispose = mocks.mockWebLinksAddonInstance.dispose
  }
}))

import { useXterm } from './use-xterm'

describe('useXterm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('should return terminal ref', () => {
    const { result } = renderHook(() => useXterm())
    expect(result.current.terminalRef).toBeDefined()
  })

  it('should return container ref', () => {
    const { result } = renderHook(() => useXterm())
    expect(result.current.containerRef).toBeDefined()
  })

  it('should return write function', () => {
    const { result } = renderHook(() => useXterm())
    expect(typeof result.current.write).toBe('function')
  })

  it('should return writeln function', () => {
    const { result } = renderHook(() => useXterm())
    expect(typeof result.current.writeln).toBe('function')
  })

  it('should return clear function', () => {
    const { result } = renderHook(() => useXterm())
    expect(typeof result.current.clear).toBe('function')
  })

  it('should return focus function', () => {
    const { result } = renderHook(() => useXterm())
    expect(typeof result.current.focus).toBe('function')
  })

  it('should return blur function', () => {
    const { result } = renderHook(() => useXterm())
    expect(typeof result.current.blur).toBe('function')
  })

  it('should return fit function', () => {
    const { result } = renderHook(() => useXterm())
    expect(typeof result.current.fit).toBe('function')
  })

  it('should return scrollToBottom function', () => {
    const { result } = renderHook(() => useXterm())
    expect(typeof result.current.scrollToBottom).toBe('function')
  })

  it('should return getCols function that defaults to 80', () => {
    const { result } = renderHook(() => useXterm())
    expect(result.current.getCols()).toBe(80)
  })

  it('should return getRows function that defaults to 24', () => {
    const { result } = renderHook(() => useXterm())
    expect(result.current.getRows()).toBe(24)
  })

  it('should accept onData option', () => {
    const onData = vi.fn()
    const { result } = renderHook(() => useXterm({ onData }))
    expect(result.current).toBeDefined()
  })

  it('should accept onResize option', () => {
    const onResize = vi.fn()
    const { result } = renderHook(() => useXterm({ onResize }))
    expect(result.current).toBeDefined()
  })

  it('should accept fontSize option', () => {
    const { result } = renderHook(() => useXterm({ fontSize: 16 }))
    expect(result.current).toBeDefined()
  })

  it('should accept fontFamily option', () => {
    const { result } = renderHook(() => useXterm({ fontFamily: 'monospace' }))
    expect(result.current).toBeDefined()
  })

  it('should accept scrollback option', () => {
    const { result } = renderHook(() => useXterm({ scrollback: 5000 }))
    expect(result.current).toBeDefined()
  })
})
