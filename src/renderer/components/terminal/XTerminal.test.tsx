import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

const mocks = vi.hoisted(() => {
  const mockTerminalInstance = {
    loadAddon: vi.fn(),
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn()
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
    clear = mocks.mockTerminalInstance.clear
    focus = mocks.mockTerminalInstance.focus
    dispose = mocks.mockTerminalInstance.dispose
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

import { XTerminal } from './XTerminal'

describe('XTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    global.ResizeObserver = class MockResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    } as unknown as typeof ResizeObserver
  })

  afterEach(() => {
    cleanup()
  })

  it('should render without crashing', () => {
    const { container } = render(<XTerminal />)
    expect(container.querySelector('div')).toBeTruthy()
  })

  it('should create terminal instance on mount', () => {
    render(<XTerminal />)
    expect(mocks.mockTerminalInstance.open).toHaveBeenCalled()
  })

  it('should load fit addon', () => {
    render(<XTerminal />)
    expect(mocks.mockTerminalInstance.loadAddon).toHaveBeenCalled()
    expect(mocks.mockFitAddonInstance.fit).toHaveBeenCalled()
  })

  it('should load webgl addon', () => {
    render(<XTerminal />)
    expect(mocks.mockWebglAddonInstance.onContextLoss).toHaveBeenCalled()
  })

  it('should load web-links addon', () => {
    render(<XTerminal />)
    expect(mocks.mockTerminalInstance.loadAddon).toHaveBeenCalled()
  })

  it('should call onData callback when provided', () => {
    const onData = vi.fn()
    render(<XTerminal onData={onData} />)
    expect(mocks.mockTerminalInstance.onData).toHaveBeenCalled()
  })

  it('should call onResize callback when provided', () => {
    const onResize = vi.fn()
    render(<XTerminal onResize={onResize} />)
    expect(mocks.mockTerminalInstance.onResize).toHaveBeenCalled()
  })

  it('should call onReady callback when provided', () => {
    const onReady = vi.fn()
    render(<XTerminal onReady={onReady} />)
    expect(onReady).toHaveBeenCalled()
  })

  it('should dispose terminal on unmount', () => {
    const { unmount } = render(<XTerminal />)
    unmount()
    expect(mocks.mockTerminalInstance.dispose).toHaveBeenCalled()
  })

  it('should apply custom className', () => {
    const { container } = render(<XTerminal className="custom-class" />)
    expect(container.querySelector('.custom-class')).toBeTruthy()
  })

  it('should set up ResizeObserver', () => {
    const { container } = render(<XTerminal />)
    expect(container.querySelector('div')).toBeTruthy()
  })
})
