import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

// Create mocks before vi.mock calls
const mockTerminalConstructor = vi.fn()
const mockTerminalInstance = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn(() => ({ dispose: vi.fn() })),
  onResize: vi.fn(() => ({ dispose: vi.fn() })),
  write: vi.fn(),
  clear: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(),
  cols: 80,
  rows: 24,
  options: {} as Record<string, unknown>
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

vi.mock('@xterm/xterm', () => ({
  Terminal: class MockTerminal {
    constructor(options?: Record<string, unknown>) {
      mockTerminalConstructor(options)
    }
    loadAddon = mockTerminalInstance.loadAddon
    open = mockTerminalInstance.open
    onData = mockTerminalInstance.onData
    onResize = mockTerminalInstance.onResize
    write = mockTerminalInstance.write
    clear = mockTerminalInstance.clear
    focus = mockTerminalInstance.focus
    dispose = mockTerminalInstance.dispose
    cols = mockTerminalInstance.cols
    rows = mockTerminalInstance.rows
    options = mockTerminalInstance.options
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit = mockFitAddonInstance.fit
    dispose = mockFitAddonInstance.dispose
  }
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class MockWebglAddon {
    onContextLoss = mockWebglAddonInstance.onContextLoss
    dispose = mockWebglAddonInstance.dispose
  }
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {
    dispose = mockWebLinksAddonInstance.dispose
  }
}))

// Mock window.api
const mockTerminalApi = {
  spawn: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(() => Promise.resolve({ success: true })),
  onData: vi.fn(() => vi.fn()),
  onExit: vi.fn(() => vi.fn())
}

Object.defineProperty(window, 'api', {
  value: { terminal: mockTerminalApi },
  writable: true
})

import { ConnectedTerminal } from './ConnectedTerminal'

describe('ConnectedTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    global.ResizeObserver = class MockResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    } as unknown as typeof ResizeObserver

    mockTerminalApi.spawn.mockResolvedValue({
      success: true,
      data: { id: 'terminal-123', shell: 'bash', cwd: '/home/user' }
    })
    mockTerminalApi.write.mockResolvedValue({ success: true, data: undefined })
    mockTerminalApi.resize.mockResolvedValue({ success: true, data: undefined })
  })

  afterEach(() => {
    cleanup()
  })

  it('should render without crashing', () => {
    const { container } = render(<ConnectedTerminal />)
    expect(container.querySelector('div')).toBeTruthy()
  })

  it('should spawn terminal on mount when no external ID provided', async () => {
    render(<ConnectedTerminal />)

    // Wait for async spawn
    await vi.waitFor(() => {
      expect(mockTerminalApi.spawn).toHaveBeenCalled()
    })
  })

  it('should call onSpawned callback with terminal ID', async () => {
    const onSpawned = vi.fn()
    render(<ConnectedTerminal onSpawned={onSpawned} />)

    await vi.waitFor(() => {
      expect(onSpawned).toHaveBeenCalledWith('terminal-123')
    })
  })

  it('should not spawn terminal when external ID provided', async () => {
    render(<ConnectedTerminal terminalId="external-123" />)

    // Give time for potential spawn
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(mockTerminalApi.spawn).not.toHaveBeenCalled()
  })

  it('should set up data listener BEFORE spawn to avoid race condition', async () => {
    // Track the order of calls
    const callOrder: string[] = []
    mockTerminalApi.onData.mockImplementation(() => {
      callOrder.push('onData')
      return vi.fn()
    })
    mockTerminalApi.spawn.mockImplementation(async () => {
      callOrder.push('spawn')
      return {
        success: true,
        data: { id: 'terminal-123', shell: 'bash', cwd: '/home/user' }
      }
    })

    render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(mockTerminalApi.spawn).toHaveBeenCalled()
    })

    // Verify onData was called BEFORE spawn
    const onDataIndex = callOrder.indexOf('onData')
    const spawnIndex = callOrder.indexOf('spawn')
    expect(onDataIndex).toBeLessThan(spawnIndex)
  })

  it('should set up exit listener BEFORE spawn to avoid race condition', async () => {
    const callOrder: string[] = []
    mockTerminalApi.onExit.mockImplementation(() => {
      callOrder.push('onExit')
      return vi.fn()
    })
    mockTerminalApi.spawn.mockImplementation(async () => {
      callOrder.push('spawn')
      return {
        success: true,
        data: { id: 'terminal-123', shell: 'bash', cwd: '/home/user' }
      }
    })

    render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(mockTerminalApi.spawn).toHaveBeenCalled()
    })

    const onExitIndex = callOrder.indexOf('onExit')
    const spawnIndex = callOrder.indexOf('spawn')
    expect(onExitIndex).toBeLessThan(spawnIndex)
  })

  it('should call onError when spawn fails', async () => {
    mockTerminalApi.spawn.mockResolvedValue({
      success: false,
      error: 'Shell not found',
      code: 'SPAWN_FAILED'
    })

    const onError = vi.fn()
    render(<ConnectedTerminal onError={onError} />)

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith('Shell not found')
    })
  })

  it('should focus terminal by default', () => {
    render(<ConnectedTerminal />)
    expect(mockTerminalInstance.focus).toHaveBeenCalled()
  })

  it('should not focus terminal when autoFocus is false', () => {
    render(<ConnectedTerminal autoFocus={false} />)
    expect(mockTerminalInstance.focus).not.toHaveBeenCalled()
  })

  it('should apply custom className', () => {
    const { container } = render(<ConnectedTerminal className="custom-class" />)
    expect(container.querySelector('.custom-class')).toBeTruthy()
  })

  it('should dispose terminal on unmount', () => {
    const { unmount } = render(<ConnectedTerminal />)
    unmount()
    expect(mockTerminalInstance.dispose).toHaveBeenCalled()
  })

  it('should pass spawn options including shell to API', async () => {
    const spawnOptions = { cwd: '/custom/path', shell: 'zsh' }
    render(<ConnectedTerminal spawnOptions={spawnOptions} />)

    await vi.waitFor(() => {
      expect(mockTerminalApi.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/custom/path',
          shell: 'zsh',
          cols: expect.any(Number),
          rows: expect.any(Number)
        })
      )
    })
  })

  it('should write PTY data to terminal when ID matches', async () => {
    let capturedDataCallback: ((id: string, data: string) => void) | null = null
    mockTerminalApi.onData.mockImplementation((cb) => {
      capturedDataCallback = cb
      return vi.fn()
    })

    render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(mockTerminalApi.spawn).toHaveBeenCalled()
    })

    // Simulate PTY data event with matching ID
    if (capturedDataCallback) {
      capturedDataCallback('terminal-123', 'Hello World')
    }

    await vi.waitFor(() => {
      expect(mockTerminalInstance.write).toHaveBeenCalledWith('Hello World')
    })
  })

  it('should NOT write PTY data when ID does not match', async () => {
    let capturedDataCallback: ((id: string, data: string) => void) | null = null
    mockTerminalApi.onData.mockImplementation((cb) => {
      capturedDataCallback = cb
      return vi.fn()
    })

    render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(mockTerminalApi.spawn).toHaveBeenCalled()
    })

    // Simulate PTY data event with NON-matching ID
    if (capturedDataCallback) {
      capturedDataCallback('terminal-999', 'Should not appear')
    }

    // Give time for potential write
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(mockTerminalInstance.write).not.toHaveBeenCalledWith('Should not appear')
  })

  it('should cleanup data listener on unmount', async () => {
    const cleanupFn = vi.fn()
    mockTerminalApi.onData.mockReturnValue(cleanupFn)

    const { unmount } = render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(mockTerminalApi.onData).toHaveBeenCalled()
    })

    unmount()

    expect(cleanupFn).toHaveBeenCalled()
  })

  it('should cleanup exit listener on unmount', async () => {
    const cleanupFn = vi.fn()
    mockTerminalApi.onExit.mockReturnValue(cleanupFn)

    const { unmount } = render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(mockTerminalApi.onExit).toHaveBeenCalled()
    })

    unmount()

    expect(cleanupFn).toHaveBeenCalled()
  })

  it('should call resize API when terminal resizes', async () => {
    let capturedResizeCallback: ((dims: { cols: number; rows: number }) => void) | null = null
    mockTerminalInstance.onResize.mockImplementation((cb) => {
      capturedResizeCallback = cb
      return { dispose: vi.fn() }
    })

    render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(mockTerminalApi.spawn).toHaveBeenCalled()
    })

    // Simulate terminal resize event
    if (capturedResizeCallback) {
      capturedResizeCallback({ cols: 120, rows: 40 })
    }

    await vi.waitFor(() => {
      expect(mockTerminalApi.resize).toHaveBeenCalledWith('terminal-123', 120, 40)
    })
  })

  it('should kill PTY process on unmount', async () => {
    const { unmount } = render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(mockTerminalApi.spawn).toHaveBeenCalled()
    })

    unmount()

    expect(mockTerminalApi.kill).toHaveBeenCalledWith('terminal-123')
  })

  describe('Windows ConPTY support', () => {
    const originalPlatform = navigator.platform

    beforeEach(() => {
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        configurable: true
      })
    })

    afterEach(() => {
      Object.defineProperty(navigator, 'platform', {
        value: originalPlatform,
        configurable: true
      })
    })

    it('should use windowsPty options on Windows', async () => {
      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalConstructor).toHaveBeenCalled()
      })

      // Verify Terminal was called with windowsPty options
      expect(mockTerminalConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          windowsPty: expect.objectContaining({
            backend: 'conpty'
          })
        })
      )
    })

    it('should have convertEol set to false', async () => {
      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalConstructor).toHaveBeenCalled()
      })

      expect(mockTerminalConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          convertEol: false
        })
      )
    })
  })

  describe('Non-Windows platform', () => {
    const originalPlatform = navigator.platform

    beforeEach(() => {
      Object.defineProperty(navigator, 'platform', {
        value: 'MacIntel',
        configurable: true
      })
    })

    afterEach(() => {
      Object.defineProperty(navigator, 'platform', {
        value: originalPlatform,
        configurable: true
      })
    })

    it('should not include windowsPty on non-Windows platforms', async () => {
      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalConstructor).toHaveBeenCalled()
      })

      // Verify Terminal was NOT called with windowsPty options
      const callArgs = mockTerminalConstructor.mock.calls[0][0]
      expect(callArgs.windowsPty).toBeUndefined()
    })
  })

  describe('Resize debouncing', () => {
    it('should debounce resize IPC calls', async () => {
      vi.useFakeTimers()

      let capturedResizeCallback: ((dims: { cols: number; rows: number }) => void) | null = null
      mockTerminalInstance.onResize.mockImplementation((cb) => {
        capturedResizeCallback = cb
        return { dispose: vi.fn() }
      })

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalApi.spawn).toHaveBeenCalled()
      })

      // Simulate multiple rapid resize events
      if (capturedResizeCallback) {
        capturedResizeCallback({ cols: 100, rows: 30 })
        capturedResizeCallback({ cols: 110, rows: 35 })
        capturedResizeCallback({ cols: 120, rows: 40 })
      }

      // Should not call resize immediately
      expect(mockTerminalApi.resize).not.toHaveBeenCalled()

      // Fast forward past debounce time
      await vi.advanceTimersByTimeAsync(50)

      // Should only call resize once with the last dimensions
      expect(mockTerminalApi.resize).toHaveBeenCalledTimes(1)
      expect(mockTerminalApi.resize).toHaveBeenCalledWith('terminal-123', 120, 40)

      vi.useRealTimers()
    })

    it('should not call resize after unmount due to cleanup', async () => {
      vi.useFakeTimers()

      let capturedResizeCallback: ((dims: { cols: number; rows: number }) => void) | null = null
      mockTerminalInstance.onResize.mockImplementation((cb) => {
        capturedResizeCallback = cb
        return { dispose: vi.fn() }
      })

      const { unmount } = render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalApi.spawn).toHaveBeenCalled()
      })

      // Trigger a resize event
      if (capturedResizeCallback) {
        capturedResizeCallback({ cols: 100, rows: 30 })
      }

      // Unmount before debounce completes
      unmount()

      // Fast forward past debounce time
      await vi.advanceTimersByTimeAsync(100)

      // Resize should not have been called because component unmounted
      expect(mockTerminalApi.resize).not.toHaveBeenCalled()

      vi.useRealTimers()
    })
  })

  describe('Dimension synchronization', () => {
    it('should pass measured dimensions to spawn', async () => {
      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalApi.spawn).toHaveBeenCalled()
      })

      // Verify spawn was called with cols and rows from terminal
      expect(mockTerminalApi.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cols: 80,
          rows: 24
        })
      )
    })

    it('should call fit before spawn to get real dimensions', async () => {
      const callOrder: string[] = []

      mockFitAddonInstance.fit.mockImplementation(() => {
        callOrder.push('fit')
      })

      mockTerminalApi.spawn.mockImplementation(async () => {
        callOrder.push('spawn')
        return {
          success: true,
          data: { id: 'terminal-123', shell: 'bash', cwd: '/home/user' }
        }
      })

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalApi.spawn).toHaveBeenCalled()
      })

      // Verify fit was called before spawn (after initial fit during terminal setup)
      const fitIndices = callOrder.reduce((acc: number[], item, idx) => {
        if (item === 'fit') acc.push(idx)
        return acc
      }, [])
      const spawnIndex = callOrder.indexOf('spawn')

      // At least one fit should happen before spawn
      expect(fitIndices.some((idx) => idx < spawnIndex)).toBe(true)
    })
  })
})
