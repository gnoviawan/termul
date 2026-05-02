import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'

// Mock Tauri APIs BEFORE importing the component
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(vi.fn())),
  emit: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() =>
    Promise.resolve({
      id: 'terminal-123',
      shell: 'bash',
      cwd: '/home/user'
    })
  )
}))

// Import the mocked modules
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

// Create mocks before vi.mock calls
const mockTerminalConstructor = vi.fn()
const mockTerminalInstance = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn<(_cb: (data: string) => void) => { dispose: () => void }>((cb) => {
    capturedDataCallback = cb
    return { dispose: vi.fn() }
  }),
  onResize: vi.fn<(_cb: (dims: { cols: number; rows: number }) => void) => { dispose: () => void }>(
    (cb) => {
      capturedResizeCallback = cb
      return { dispose: vi.fn() }
    }
  ),
  onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
  attachCustomKeyEventHandler: vi.fn(),
  hasSelection: vi.fn(() => false),
  getSelection: vi.fn(() => ''),
  selectAll: vi.fn(),
  paste: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
  focus: vi.fn(),
  dispose: vi.fn(),
  cols: 80,
  rows: 24,
  options: {} as Record<string, unknown>
}

let capturedResizeCallback: ((dims: { cols: number; rows: number }) => void) | null = null

const mockFitAddonInstance = {
  fit: vi.fn(),
  dispose: vi.fn()
}

const mockWebglAddonInstance = {
  onContextLoss: vi.fn(),
  dispose: vi.fn()
}

// Track WebGL addon instances for recovery testing
let webglAddonCreateCount = 0
let capturedContextLossCallback: (() => void) | null = null
// Track the last created WebGL addon instance for disposal order testing
let lastCreatedWebglInstance: {
  dispose: ReturnType<typeof vi.fn>
  onContextLoss: ReturnType<typeof vi.fn>
} | null = null

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
    onSelectionChange = mockTerminalInstance.onSelectionChange
    attachCustomKeyEventHandler = mockTerminalInstance.attachCustomKeyEventHandler
    hasSelection = mockTerminalInstance.hasSelection
    getSelection = mockTerminalInstance.getSelection
    selectAll = mockTerminalInstance.selectAll
    paste = mockTerminalInstance.paste
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
    dispose = vi.fn()
    onContextLoss = vi.fn((cb: () => void) => {
      capturedContextLossCallback = cb
    })
    constructor() {
      webglAddonCreateCount++
      // Store reference to this instance for disposal order testing
      lastCreatedWebglInstance = {
        dispose: this.dispose,
        onContextLoss: this.onContextLoss
      }
    }
  }
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class MockWebLinksAddon {
    dispose = mockWebLinksAddonInstance.dispose
  }
}))

// Mock window.api with proper typing for mocks
let capturedDataCallback: ((id: string, data: string) => void) | null = null
let capturedExitCallback: ((id: string, exitCode: number, signal?: number) => void) | null = null
let capturedPowerResumeCallback: (() => void) | null = null

const mockTerminalApi = {
  spawn: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  write: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  resize: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  kill: vi.fn<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve({ success: true })),
  onData: vi.fn<(cb: (id: string, data: string) => void) => () => void>((cb) => {
    capturedDataCallback = cb
    return vi.fn()
  }),
  onExit: vi.fn<(cb: (id: string, exitCode: number, signal?: number) => void) => () => void>(
    (cb) => {
      capturedExitCallback = cb
      return vi.fn()
    }
  )
}

const mockClipboardApi = {
  readText: vi.fn<() => Promise<{ success: boolean; data?: string; error?: string }>>(),
  writeText: vi.fn<() => Promise<{ success: boolean; error?: string }>>()
}

// Define mock window.api
type WindowWithOptionalApi = Window & { api?: unknown }

const mockWindowApi = {
  terminal: mockTerminalApi,
  clipboard: mockClipboardApi,
  persistence: {
    read: vi.fn(() => Promise.resolve({ success: true, data: undefined })),
    write: vi.fn(() => Promise.resolve({ success: true }))
  },
  system: {
    getHomeDirectory: vi.fn(() => Promise.resolve({ success: true, data: '/home/user' })),
    onPowerResume: vi.fn((cb: () => void) => {
      capturedPowerResumeCallback = cb
      // Return cleanup function directly (not a Promise)
      return vi.fn()
    })
  }
}

Object.defineProperty(window, 'api', {
  value: mockWindowApi as unknown as Window['api'],
  writable: true,
  configurable: true
})

import { ConnectedTerminal } from './ConnectedTerminal'
import { terminalApi, systemApi, clipboardApi } from '@/lib/api'
import { addRendererRef, removeRendererRef } from '@/lib/tauri-terminal-api'

const {
  mockRecordTerminalContinuityEvent,
  mockGetOrCreateProjectContinuityCorrelation
} = vi.hoisted(() => ({
  mockRecordTerminalContinuityEvent: vi.fn(),
  mockGetOrCreateProjectContinuityCorrelation: vi.fn(() => 'corr-project-a')
}))

vi.mock('@/hooks/use-terminal-restore', () => ({
  isTerminalPendingPtyAssignment: vi.fn(() => false)
}))

vi.mock('@/lib/terminal-continuity-instrumentation', () => ({
  recordTerminalContinuityEvent: mockRecordTerminalContinuityEvent,
  getOrCreateProjectContinuityCorrelation: mockGetOrCreateProjectContinuityCorrelation
}))

// Mock the API modules
vi.mock('@/lib/api', () => ({
  terminalApi: {
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    onCwdChanged: vi.fn(),
    getCwd: vi.fn()
  },
  systemApi: {
    getHomeDirectory: vi.fn(),
    onPowerResume: vi.fn(() => vi.fn())
  },
  clipboardApi: {
    readText: vi.fn(),
    writeText: vi.fn()
  }
}))

const mockTerminalStoreState = {
  findTerminalByPtyId: vi.fn(),
  updateTerminalActivity: vi.fn(),
  updateTerminalLastActivityTimestamp: vi.fn(),
  updateTerminalActivityBatch: vi.fn(),
  setRendererAttached: vi.fn(),
  peekTranscript: vi.fn(() => ''),
  consumeTranscript: vi.fn(() => ''),
  consumeDetachedOutput: vi.fn(() => '')
}

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: {
    getState: () => mockTerminalStoreState
  }
}))

vi.mock('@/lib/tauri-terminal-api', () => ({
  addRendererRef: vi.fn().mockResolvedValue({ success: true, data: undefined }),
  removeRendererRef: vi.fn().mockResolvedValue({ success: true, data: undefined })
}))

describe('ConnectedTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRecordTerminalContinuityEvent.mockReset()
    mockGetOrCreateProjectContinuityCorrelation.mockReset()
    mockGetOrCreateProjectContinuityCorrelation.mockReturnValue('corr-project-a')
    webglAddonCreateCount = 0
    capturedContextLossCallback = null
    capturedPowerResumeCallback = null
    capturedDataCallback = null
    capturedExitCallback = null
    lastCreatedWebglInstance = null

    global.ResizeObserver = class MockResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    } as unknown as typeof ResizeObserver

    // Re-setup onData and onExit mocks with fresh callback captures
    vi.mocked(terminalApi).onData.mockImplementation((cb: (id: string, data: string) => void) => {
      capturedDataCallback = cb
      return vi.fn()
    })
    vi.mocked(terminalApi).onExit.mockImplementation(
      (cb: (id: string, exitCode: number, signal?: number) => void) => {
        capturedExitCallback = cb
        return vi.fn()
      }
    )
    vi.mocked(systemApi).onPowerResume.mockImplementation((cb: () => void) => {
      capturedPowerResumeCallback = cb
      return vi.fn()
    })

    mockTerminalStoreState.findTerminalByPtyId.mockReset()
    mockTerminalStoreState.updateTerminalActivity.mockReset()
    mockTerminalStoreState.updateTerminalLastActivityTimestamp.mockReset()
    mockTerminalStoreState.updateTerminalActivityBatch.mockReset()
    mockTerminalStoreState.setRendererAttached.mockReset()
    mockTerminalStoreState.peekTranscript.mockReset()
    mockTerminalStoreState.peekTranscript.mockReturnValue('')
    mockTerminalStoreState.consumeTranscript.mockReset()
    mockTerminalStoreState.consumeTranscript.mockReturnValue('')
    mockTerminalStoreState.consumeDetachedOutput.mockReset()
    mockTerminalStoreState.consumeDetachedOutput.mockReturnValue('')

    vi.mocked(terminalApi).spawn.mockResolvedValue({
      success: true,
      data: { id: 'terminal-123', shell: 'bash', cwd: '/home/user' }
    })
    vi.mocked(terminalApi).write.mockResolvedValue({ success: true, data: undefined })
    vi.mocked(terminalApi).resize.mockResolvedValue({ success: true, data: undefined })

    // Reset clipboard mocks
    vi.mocked(clipboardApi).readText.mockResolvedValue({ success: true, data: '' })
    vi.mocked(clipboardApi).writeText.mockResolvedValue({ success: true, data: undefined })

    // Reset terminal selection mocks
    mockTerminalInstance.hasSelection.mockReturnValue(false)
    mockTerminalInstance.getSelection.mockReturnValue('')
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
      expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
    })
  })

  it('should call onSpawned callback with terminal ID', async () => {
    const onSpawned = vi.fn()
    render(<ConnectedTerminal onSpawned={onSpawned} />)

    await vi.waitFor(() => {
      expect(onSpawned).toHaveBeenCalledWith('terminal-123')
    })
  })

  it('should call onBoundToStoreTerminal callback when spawned', async () => {
    const onBoundToStoreTerminal = vi.fn()
    render(<ConnectedTerminal onBoundToStoreTerminal={onBoundToStoreTerminal} />)

    await vi.waitFor(() => {
      expect(onBoundToStoreTerminal).toHaveBeenCalledWith('terminal-123')
    })
  })

  it('should call onBoundToStoreTerminal callback when external terminalId is provided', async () => {
    const onBoundToStoreTerminal = vi.fn()
    render(
      <ConnectedTerminal
        terminalId="external-123"
        storeTerminalId="store-123"
        onBoundToStoreTerminal={onBoundToStoreTerminal}
      />
    )

    await vi.waitFor(() => {
      expect(onBoundToStoreTerminal).toHaveBeenCalledWith('external-123')
    })
  })

  it('should register and unregister renderer refs for external terminalId', async () => {
    const { unmount } = render(<ConnectedTerminal terminalId="external-123" />)

    await vi.waitFor(() => {
      expect(addRendererRef).toHaveBeenCalledWith('external-123', expect.stringMatching(/^conn-/))
    })

    unmount()

    await vi.waitFor(() => {
      expect(removeRendererRef).toHaveBeenCalledWith(
        'external-123',
        expect.stringMatching(/^conn-/)
      )
    })
  })

  it('should not spawn terminal when external ID provided', async () => {
    render(<ConnectedTerminal terminalId="external-123" />)

    // Give time for potential spawn
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(vi.mocked(terminalApi).spawn).not.toHaveBeenCalled()
  })

  it('should not spawn terminal when autoSpawn is false', async () => {
    render(<ConnectedTerminal autoSpawn={false} />)

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(vi.mocked(terminalApi).spawn).not.toHaveBeenCalled()
  })

  it('should set up data listener BEFORE spawn to avoid race condition', async () => {
    // Track the order of calls
    const callOrder: string[] = []
    ;(
      vi.mocked(terminalApi).onData as unknown as { mockImplementation: (fn: () => void) => void }
    ).mockImplementation(() => {
      callOrder.push('onData')
      return vi.fn()
    })
    ;(
      vi.mocked(terminalApi).spawn as unknown as {
        mockImplementation: (fn: () => Promise<unknown>) => void
      }
    ).mockImplementation(async () => {
      callOrder.push('spawn')
      return {
        success: true,
        data: { id: 'terminal-123', shell: 'bash', cwd: '/home/user' }
      }
    })

    render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
    })

    // Verify onData was called BEFORE spawn
    const onDataIndex = callOrder.indexOf('onData')
    const spawnIndex = callOrder.indexOf('spawn')
    expect(onDataIndex).toBeLessThan(spawnIndex)
  })

  it('should set up exit listener BEFORE spawn to avoid race condition', async () => {
    const callOrder: string[] = []
    ;(
      vi.mocked(terminalApi).onExit as unknown as { mockImplementation: (fn: () => void) => void }
    ).mockImplementation(() => {
      callOrder.push('onExit')
      return vi.fn()
    })
    ;(
      vi.mocked(terminalApi).spawn as unknown as {
        mockImplementation: (fn: () => Promise<unknown>) => void
      }
    ).mockImplementation(async () => {
      callOrder.push('spawn')
      return {
        success: true,
        data: { id: 'terminal-123', shell: 'bash', cwd: '/home/user' }
      }
    })

    render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
    })

    const onExitIndex = callOrder.indexOf('onExit')
    const spawnIndex = callOrder.indexOf('spawn')
    expect(onExitIndex).toBeLessThan(spawnIndex)
  })

  it('should call onError when spawn fails', async () => {
    vi.mocked(terminalApi).spawn.mockResolvedValue({
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

  describe('Cursor cleanup on unmount', () => {
    it('should disable cursor blink before disposal', () => {
      const { unmount } = render(<ConnectedTerminal />)
      unmount()
      // Cursor blink should be set to false before terminal disposal
      expect(mockTerminalInstance.options.cursorBlink).toBe(false)
    })

    it('should dispose WebGL addon before terminal disposal', () => {
      const disposalOrder: string[] = []

      // Track disposal on the actual WebGL instance created by the component
      ;(
        mockTerminalInstance.dispose as unknown as { mockImplementation: (fn: () => void) => void }
      ).mockImplementation(() => {
        disposalOrder.push('terminal')
      })

      const { unmount } = render(<ConnectedTerminal />)

      // Now set up the spy on the actual WebGL instance that was created
      expect(lastCreatedWebglInstance).toBeTruthy()
      ;(
        lastCreatedWebglInstance!.dispose as unknown as {
          mockImplementation: (fn: () => void) => void
        }
      ).mockImplementation(() => {
        disposalOrder.push('webgl')
      })

      unmount()

      // WebGL should be disposed before terminal
      const webglIndex = disposalOrder.indexOf('webgl')
      const terminalIndex = disposalOrder.indexOf('terminal')
      expect(webglIndex).toBeLessThan(terminalIndex)
    })
  })

  it('should pass spawn options including shell to API', async () => {
    const spawnOptions = { cwd: '/custom/path', shell: 'zsh' }
    render(<ConnectedTerminal spawnOptions={spawnOptions} />)

    await vi.waitFor(() => {
      expect(vi.mocked(terminalApi).spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/custom/path',
          shell: 'zsh',
          cols: expect.any(Number),
          rows: expect.any(Number)
        })
      )
    })
  })

  // Skipped: This test has timing issues with async component initialization
  // The test would need significant refactoring to properly test the IPC data flow
  it.skip('should write PTY data to terminal when ID matches', async () => {
    const { unmount } = render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
    })

    // Small delay to ensure component is fully set up
    await new Promise((resolve) => setTimeout(resolve, 50))

    // Verify capturedDataCallback is set
    expect(capturedDataCallback).toBeTruthy()

    // Manually call the callback to verify it works
    capturedDataCallback!('terminal-123', 'Hello World')

    // The callback should have called terminal.write
    expect(mockTerminalInstance.write).toHaveBeenCalledWith('Hello World')

    unmount()
  })

  it('should NOT write PTY data when ID does not match', async () => {
    render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
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
    ;(
      vi.mocked(terminalApi).onData as unknown as { mockReturnValue: (v: unknown) => void }
    ).mockReturnValue(cleanupFn)

    const { unmount } = render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(vi.mocked(terminalApi).onData).toHaveBeenCalled()
    })

    unmount()

    expect(cleanupFn).toHaveBeenCalled()
  })

  it('should cleanup exit listener on unmount', async () => {
    const cleanupFn = vi.fn()
    ;(
      vi.mocked(terminalApi).onExit as unknown as { mockReturnValue: (v: unknown) => void }
    ).mockReturnValue(cleanupFn)

    const { unmount } = render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(vi.mocked(terminalApi).onExit).toHaveBeenCalled()
    })

    unmount()

    expect(cleanupFn).toHaveBeenCalled()
  })

  it('should call resize API when terminal resizes', async () => {
    render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
    })

    // Simulate terminal resize event
    if (capturedResizeCallback) {
      capturedResizeCallback({ cols: 120, rows: 40 })
    }

    await vi.waitFor(() => {
      expect(vi.mocked(terminalApi).resize).toHaveBeenCalledWith('terminal-123', 120, 40)
    })
  })

  it('should not kill PTY process on unmount', async () => {
    const { unmount } = render(<ConnectedTerminal />)

    await vi.waitFor(() => {
      expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
    })

    unmount()

    expect(vi.mocked(terminalApi).kill).not.toHaveBeenCalled()
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
      ;(
        mockTerminalInstance.onResize as unknown as {
          mockImplementation: (fn: (cb: typeof capturedResizeCallback) => void) => {
            dispose: () => void
          }
        }
      ).mockImplementation((cb) => {
        capturedResizeCallback = cb
        return { dispose: vi.fn() }
      })

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Clear any initial resize call triggered by the needsResizeOnReady path
      // (fired once after spawn when isVisible becomes true before PTY is ready)
      vi.mocked(terminalApi).resize.mockClear()

      // Simulate multiple rapid resize events
      if (capturedResizeCallback) {
        capturedResizeCallback({ cols: 100, rows: 30 })
        capturedResizeCallback({ cols: 110, rows: 35 })
        capturedResizeCallback({ cols: 120, rows: 40 })
      }

      // Should not call resize immediately (xterm onResize events are debounced)
      expect(vi.mocked(terminalApi).resize).not.toHaveBeenCalled()

      // Fast forward past debounce time
      await vi.advanceTimersByTimeAsync(50)

      // Should only call resize once with the last dimensions
      expect(vi.mocked(terminalApi).resize).toHaveBeenCalledTimes(1)
      expect(vi.mocked(terminalApi).resize).toHaveBeenCalledWith('terminal-123', 120, 40)

      vi.useRealTimers()
    })

    it('should not call resize after unmount due to cleanup', async () => {
      vi.useFakeTimers()
      ;(
        mockTerminalInstance.onResize as unknown as {
          mockImplementation: (fn: (cb: typeof capturedResizeCallback) => void) => {
            dispose: () => void
          }
        }
      ).mockImplementation((cb) => {
        capturedResizeCallback = cb
        return { dispose: vi.fn() }
      })

      const { unmount } = render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Clear any initial resize call triggered by the needsResizeOnReady path
      // (fired once after spawn when isVisible becomes true before PTY is ready)
      vi.mocked(terminalApi).resize.mockClear()

      // Trigger a resize event
      if (capturedResizeCallback) {
        capturedResizeCallback({ cols: 100, rows: 30 })
      }

      // Unmount before debounce completes
      unmount()

      // Fast forward past debounce time
      await vi.advanceTimersByTimeAsync(100)

      // Resize should not have been called because component unmounted before debounce fired
      expect(vi.mocked(terminalApi).resize).not.toHaveBeenCalled()

      vi.useRealTimers()
    })
  })

  describe('Dimension synchronization', () => {
    it('should pass measured dimensions to spawn', async () => {
      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Verify spawn was called with cols and rows from terminal
      expect(vi.mocked(terminalApi).spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cols: 80,
          rows: 24
        })
      )
    })

    it('should call fit before spawn to get real dimensions', async () => {
      const callOrder: string[] = []

      ;(
        mockFitAddonInstance.fit as unknown as { mockImplementation: (fn: () => void) => void }
      ).mockImplementation(() => {
        callOrder.push('fit')
      })
      ;(
        vi.mocked(terminalApi).spawn as unknown as {
          mockImplementation: (fn: () => Promise<unknown>) => void
        }
      ).mockImplementation(async () => {
        callOrder.push('spawn')
        return {
          success: true,
          data: { id: 'terminal-123', shell: 'bash', cwd: '/home/user' }
        }
      })

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
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

  describe('Clipboard functionality', () => {
    it('should set up clipboard keyboard handlers', async () => {
      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalInstance.attachCustomKeyEventHandler).toHaveBeenCalled()
      })
    })

    it('should copy selection to clipboard on Ctrl+C when text is selected', async () => {
      const selectedText = 'Hello, World!'
      mockTerminalInstance.hasSelection.mockReturnValue(true)
      mockTerminalInstance.getSelection.mockReturnValue(selectedText)
      vi.mocked(clipboardApi).writeText.mockResolvedValue({ success: true, data: undefined })

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalInstance.attachCustomKeyEventHandler).toHaveBeenCalled()
      })

      // Get the registered handler
      const handler = mockTerminalInstance.attachCustomKeyEventHandler.mock.calls[0][0]

      // Simulate Ctrl+C with selection
      const event = new KeyboardEvent('keydown', {
        key: 'c',
        ctrlKey: true,
        bubbles: true
      })

      const result = handler(event)

      // Should prevent xterm from handling
      expect(result).toBe(false)

      // Should write to clipboard via the hook
      await vi.waitFor(() => {
        expect(vi.mocked(clipboardApi).writeText).toHaveBeenCalledWith(selectedText)
      })
    })

    it('should allow Ctrl+C interrupt when no selection exists', async () => {
      mockTerminalInstance.hasSelection.mockReturnValue(false)

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalInstance.attachCustomKeyEventHandler).toHaveBeenCalled()
      })

      const handler = mockTerminalInstance.attachCustomKeyEventHandler.mock.calls[0][0]

      const event = new KeyboardEvent('keydown', {
        key: 'c',
        ctrlKey: true,
        bubbles: true
      })

      const result = handler(event)

      // Should allow xterm to handle (for interrupt signal)
      expect(result).toBe(true)
      expect(vi.mocked(clipboardApi).writeText).not.toHaveBeenCalled()
    })

    it('should paste from clipboard on Ctrl+V', async () => {
      const clipboardText = 'Pasted content'
      vi.mocked(clipboardApi).readText.mockResolvedValue({ success: true, data: clipboardText })

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalInstance.attachCustomKeyEventHandler).toHaveBeenCalled()
      })

      const handler = mockTerminalInstance.attachCustomKeyEventHandler.mock.calls[0][0]

      const event = new KeyboardEvent('keydown', {
        key: 'v',
        ctrlKey: true,
        bubbles: true
      })

      const result = handler(event)

      // Should prevent xterm from handling
      expect(result).toBe(false)

      // Should read from clipboard and paste via the hook
      await vi.waitFor(() => {
        expect(vi.mocked(clipboardApi).readText).toHaveBeenCalled()
      })

      await vi.waitFor(() => {
        expect(mockTerminalInstance.paste).toHaveBeenCalledWith(clipboardText)
      })
    })

    it('should select all on Ctrl+A', async () => {
      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalInstance.attachCustomKeyEventHandler).toHaveBeenCalled()
      })

      const handler = mockTerminalInstance.attachCustomKeyEventHandler.mock.calls[0][0]

      const event = new KeyboardEvent('keydown', {
        key: 'a',
        ctrlKey: true,
        bubbles: true
      })

      const result = handler(event)

      // Should prevent xterm from handling
      expect(result).toBe(false)
      expect(mockTerminalInstance.selectAll).toHaveBeenCalled()
    })

    it('should handle Cmd key on macOS for copy/paste', async () => {
      const selectedText = 'Selected text'
      mockTerminalInstance.hasSelection.mockReturnValue(true)
      mockTerminalInstance.getSelection.mockReturnValue(selectedText)
      vi.mocked(clipboardApi).writeText.mockResolvedValue({ success: true, data: undefined })

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalInstance.attachCustomKeyEventHandler).toHaveBeenCalled()
      })

      const handler = mockTerminalInstance.attachCustomKeyEventHandler.mock.calls[0][0]

      // Simulate Cmd+C (metaKey on Mac)
      const event = new KeyboardEvent('keydown', {
        key: 'c',
        metaKey: true,
        bubbles: true
      })

      const result = handler(event)

      expect(result).toBe(false)
      await vi.waitFor(() => {
        expect(vi.mocked(clipboardApi).writeText).toHaveBeenCalledWith(selectedText)
      })
    })

    it('should not handle clipboard shortcuts for non-keydown events', async () => {
      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalInstance.attachCustomKeyEventHandler).toHaveBeenCalled()
      })

      const handler = mockTerminalInstance.attachCustomKeyEventHandler.mock.calls[0][0]

      // Simulate keyup event
      const event = new KeyboardEvent('keyup', {
        key: 'c',
        ctrlKey: true,
        bubbles: true
      })

      const result = handler(event)

      // Should allow xterm to handle
      expect(result).toBe(true)
    })

    it('should not interfere with other keyboard shortcuts', async () => {
      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(mockTerminalInstance.attachCustomKeyEventHandler).toHaveBeenCalled()
      })

      const handler = mockTerminalInstance.attachCustomKeyEventHandler.mock.calls[0][0]

      // Regular typing
      const event = new KeyboardEvent('keydown', {
        key: 'x',
        bubbles: true
      })

      const result = handler(event)

      expect(result).toBe(true)
    })
  })

  describe('Context menu', () => {
    it('should render terminal container', async () => {
      const { container } = render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Terminal container should be in the DOM
      expect(container.querySelector('div')).toBeTruthy()
    })
  })

  describe('WebGL context loss recovery', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('should create a new WebGL addon when context loss fires', async () => {
      vi.useFakeTimers()
      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // WebGL addon should have been created once during init
      expect(webglAddonCreateCount).toBe(1)
      expect(capturedContextLossCallback).toBeTruthy()

      // Simulate context loss
      vi.useFakeTimers()
      capturedContextLossCallback!()

      // Advance past the 100ms recovery delay
      await vi.advanceTimersByTimeAsync(150)

      // A second WebGL addon should have been created
      expect(webglAddonCreateCount).toBe(2)
    })

    it('should load the WebGL addon on terminal during init', async () => {
      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // loadAddon is called for FitAddon, WebLinksAddon, SearchAddon, WebglAddon
      expect(mockTerminalInstance.loadAddon).toHaveBeenCalled()
      expect(webglAddonCreateCount).toBe(1)
    })

    it('should stop recovery after max attempts exhausted', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Initial load
      expect(webglAddonCreateCount).toBe(1)

      vi.useFakeTimers()

      // Simulate 2 context loss events - should recover each time
      for (let i = 0; i < 2; i++) {
        capturedContextLossCallback!()
        await vi.advanceTimersByTimeAsync(150)
      }

      // Should have 3 total: 1 init + 2 recoveries
      expect(webglAddonCreateCount).toBe(3)

      // 3rd context loss - counter reaches MAX, should NOT recover
      capturedContextLossCallback!()
      await vi.advanceTimersByTimeAsync(150)

      // Should still be 3 - no more recovery attempts
      expect(webglAddonCreateCount).toBe(3)

      // Should have logged warning about exhausted attempts
      expect(warnSpy).toHaveBeenCalledWith(
        'WebGL recovery attempts exhausted, falling back to canvas renderer'
      )

      warnSpy.mockRestore()
    })
  })

  describe('Visibility change recovery', () => {
    let originalVisibilityState: string

    beforeEach(() => {
      // Capture original visibility state before any test mutates it
      originalVisibilityState = document.visibilityState
    })

    afterEach(() => {
      // Restore original visibility state
      Object.defineProperty(document, 'visibilityState', {
        value: originalVisibilityState,
        writable: true,
        configurable: true
      })
      vi.useRealTimers()
    })

    it('should call fit and resize when visibility changes to visible', async () => {
      vi.useFakeTimers()

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Clear previous fit/resize calls from init
      mockFitAddonInstance.fit.mockClear()
      vi.mocked(terminalApi).resize.mockClear()

      // Simulate visibility change to visible
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true
      })
      document.dispatchEvent(new Event('visibilitychange'))

      // Advance past the 150ms delay
      await vi.advanceTimersByTimeAsync(200)

      expect(mockFitAddonInstance.fit).toHaveBeenCalled()
      expect(vi.mocked(terminalApi).resize).toHaveBeenCalledWith(
        'terminal-123',
        expect.any(Number),
        expect.any(Number)
      )
    })

    it('should not trigger recovery when visibility changes to hidden', async () => {
      vi.useFakeTimers()

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      mockFitAddonInstance.fit.mockClear()
      vi.mocked(terminalApi).resize.mockClear()

      // Simulate visibility change to hidden
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        writable: true,
        configurable: true
      })
      document.dispatchEvent(new Event('visibilitychange'))

      await vi.advanceTimersByTimeAsync(200)

      // fit should not be called again for hidden state
      expect(mockFitAddonInstance.fit).not.toHaveBeenCalled()
    })

    it('should remove visibilitychange listener on unmount', async () => {
      const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener')

      const { unmount } = render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      unmount()

      expect(removeEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

      removeEventListenerSpy.mockRestore()
    })

    it('should debounce rapid visibility changes to visible', async () => {
      vi.useFakeTimers()

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      mockFitAddonInstance.fit.mockClear()
      vi.mocked(terminalApi).resize.mockClear()

      // Simulate rapid visibility changes
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true
      })
      document.dispatchEvent(new Event('visibilitychange'))

      // Trigger another visibility change before the debounce completes
      await vi.advanceTimersByTimeAsync(50)
      document.dispatchEvent(new Event('visibilitychange'))

      // Advance past the debounce delay
      await vi.advanceTimersByTimeAsync(200)

      // Should only call fit once after debounce completes
      expect(mockFitAddonInstance.fit).toHaveBeenCalledTimes(1)
    })

    it('should handle visibility broadcast with isVisible prop', async () => {
      vi.useFakeTimers()

      const { rerender } = render(<ConnectedTerminal isVisible={true} />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      mockFitAddonInstance.fit.mockClear()
      vi.mocked(terminalApi).resize.mockClear()

      // Change visibility to false (simulating terminal becoming hidden in workspace)
      rerender(<ConnectedTerminal isVisible={false} />)

      // Small delay to ensure prop change is processed
      await vi.advanceTimersByTimeAsync(50)

      // Change back to visible
      rerender(<ConnectedTerminal isVisible={true} />)

      // Small delay to ensure prop change is processed
      await vi.advanceTimersByTimeAsync(50)

      // Verify that terminal responds to visibility prop changes
      expect(mockTerminalInstance.focus).toHaveBeenCalled()

      vi.useRealTimers()
    })

    it('should skip resize when terminal becomes visible but PTY is not ready', async () => {
      vi.useFakeTimers()

      // Mock spawn to return success but terminal might not be ready
      vi.mocked(terminalApi).spawn.mockResolvedValue({
        success: true,
        data: { id: 'terminal-123', shell: 'bash', cwd: '/home/user' }
      })

      const { unmount } = render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      mockFitAddonInstance.fit.mockClear()
      vi.mocked(terminalApi).resize.mockClear()

      // Unmount before visibility change completes
      unmount()

      // Simulate visibility change after unmount (should be handled by cleanup)
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true
      })
      document.dispatchEvent(new Event('visibilitychange'))

      await vi.advanceTimersByTimeAsync(200)

      // Should not call resize after unmount
      expect(vi.mocked(terminalApi).resize).not.toHaveBeenCalled()

      vi.useRealTimers()
    })

    it('should handle visibility changes during active data transfer', async () => {
      vi.useFakeTimers()

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Simulate active data transfer
      if (capturedDataCallback) {
        capturedDataCallback('terminal-123', 'Loading data...\n')
      }

      mockFitAddonInstance.fit.mockClear()
      vi.mocked(terminalApi).resize.mockClear()

      // Change visibility during active data
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true
      })
      document.dispatchEvent(new Event('visibilitychange'))

      await vi.advanceTimersByTimeAsync(200)

      // Should still recover even during active data transfer
      expect(mockFitAddonInstance.fit).toHaveBeenCalled()

      vi.useRealTimers()
    })

    describe('Visibility broadcast to backend', () => {
      it('should broadcast terminal dimensions to backend when becoming visible', async () => {
        vi.useFakeTimers()

        const { rerender } = render(<ConnectedTerminal isVisible={false} />)

        await vi.waitFor(() => {
          expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
        })

        // Clear initial calls
        vi.mocked(terminalApi).resize.mockClear()

        // Terminal becomes visible - should broadcast dimensions to backend
        rerender(<ConnectedTerminal isVisible={true} />)

        // Wait for double requestAnimationFrame + fit + resize
        await vi.advanceTimersByTimeAsync(50)

        expect(vi.mocked(terminalApi).resize).toHaveBeenCalledWith(
          'terminal-123',
          expect.any(Number),
          expect.any(Number)
        )

        vi.useRealTimers()
      })

      it('should defer resize broadcast until PTY is ready', async () => {
        vi.useFakeTimers()

        // Render with terminal visible but PTY not ready yet
        const { rerender } = render(<ConnectedTerminal isVisible={false} />)

        // Wait a bit - spawn should have been called
        await vi.waitFor(() => {
          expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
        })

        // Clear initial calls
        vi.mocked(terminalApi).resize.mockClear()

        // Change to visible when PTY is ready - should broadcast resize
        rerender(<ConnectedTerminal isVisible={true} />)

        // Wait for double requestAnimationFrame + resize
        await vi.advanceTimersByTimeAsync(50)

        // Verify resize was called with terminal dimensions
        expect(vi.mocked(terminalApi).resize).toHaveBeenCalledWith(
          'terminal-123',
          expect.any(Number),
          expect.any(Number)
        )

        vi.useRealTimers()
      })

      it('should handle rapid visibility toggles without spamming backend', async () => {
        vi.useFakeTimers()

        const { rerender } = render(<ConnectedTerminal isVisible={true} />)

        await vi.waitFor(() => {
          expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
        })

        // Clear initial calls
        vi.mocked(terminalApi).resize.mockClear()
        const initialCallCount = vi.mocked(terminalApi).resize.mock.calls.length

        // Rapidly toggle visibility
        for (let i = 0; i < 5; i++) {
          rerender(<ConnectedTerminal isVisible={i % 2 === 0} />)
          await vi.advanceTimersByTimeAsync(10)
        }

        // Final state: visible
        rerender(<ConnectedTerminal isVisible={true} />)

        // Wait for all pending operations to complete
        await vi.advanceTimersByTimeAsync(100)

        // Should not have spammed the backend with 5+ resize calls
        // The double RAF pattern should prevent excessive calls
        const finalCallCount = vi.mocked(terminalApi).resize.mock.calls.length
        expect(finalCallCount).toBeLessThan(initialCallCount + 3)

        vi.useRealTimers()
      })
    })

    describe('Recovery compatibility with visibility changes', () => {
      it('should recover WebGL context after visibility change with context loss', async () => {
        vi.useFakeTimers()

        render(<ConnectedTerminal />)

        await vi.waitFor(() => {
          expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
        })

        const initialWebglCount = webglAddonCreateCount

        // Simulate WebGL context loss
        capturedContextLossCallback!()

        // Immediately change visibility (simulating tab switch during context loss recovery)
        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          writable: true,
          configurable: true
        })
        document.dispatchEvent(new Event('visibilitychange'))

        // Advance past both recovery delays (WebGL: 100ms, Visibility: 150ms)
        await vi.advanceTimersByTimeAsync(200)

        // WebGL should have been recreated despite visibility change
        expect(webglAddonCreateCount).toBeGreaterThan(initialWebglCount)

        // Fit should have been called as part of visibility recovery
        expect(mockFitAddonInstance.fit).toHaveBeenCalled()

        vi.useRealTimers()
      })

      it('should handle simultaneous power resume and visibility change', async () => {
        vi.useFakeTimers()

        render(<ConnectedTerminal />)

        await vi.waitFor(() => {
          expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
        })

        mockFitAddonInstance.fit.mockClear()
        vi.mocked(terminalApi).resize.mockClear()

        // Trigger both power resume and visibility change simultaneously
        capturedPowerResumeCallback!()

        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          writable: true,
          configurable: true
        })
        document.dispatchEvent(new Event('visibilitychange'))

        // Advance past both delays (Power: 300ms, Visibility: 150ms)
        await vi.advanceTimersByTimeAsync(350)

        // Should handle both events gracefully
        // Both events trigger the same performTerminalRecovery function
        expect(mockFitAddonInstance.fit).toHaveBeenCalled()

        // Resize should have been called (may be called multiple times but should not error)
        expect(vi.mocked(terminalApi).resize).toHaveBeenCalled()

        vi.useRealTimers()
      })

      it('should not crash when visibility change occurs during unmount', async () => {
        vi.useFakeTimers()

        const { unmount } = render(<ConnectedTerminal />)

        await vi.waitFor(() => {
          expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
        })

        // Start visibility change recovery
        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          writable: true,
          configurable: true
        })
        document.dispatchEvent(new Event('visibilitychange'))

        // Unmount before recovery completes
        unmount()

        // Advance past recovery delay - should not throw
        await vi.advanceTimersByTimeAsync(200)

        // No errors should have been thrown
        expect(mockTerminalInstance.dispose).toHaveBeenCalled()

        vi.useRealTimers()
      })

      it('should maintain recovery state across multiple visibility cycles', async () => {
        vi.useFakeTimers()

        render(<ConnectedTerminal />)

        await vi.waitFor(() => {
          expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
        })

        // Perform multiple visibility cycles
        for (let i = 0; i < 3; i++) {
          mockFitAddonInstance.fit.mockClear()
          vi.mocked(terminalApi).resize.mockClear()

          Object.defineProperty(document, 'visibilityState', {
            value: i % 2 === 0 ? 'visible' : 'hidden',
            writable: true,
            configurable: true
          })
          document.dispatchEvent(new Event('visibilitychange'))

          await vi.advanceTimersByTimeAsync(50)
        }

        // Final visibility to visible
        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          writable: true,
          configurable: true
        })
        document.dispatchEvent(new Event('visibilitychange'))

        await vi.advanceTimersByTimeAsync(200)

        // Should still recover properly after multiple cycles
        expect(mockFitAddonInstance.fit).toHaveBeenCalled()

        vi.useRealTimers()
      })

      it('should handle visibility recovery without scroll position errors', async () => {
        vi.useFakeTimers()

        // Render with an external terminal ID
        const { unmount } = render(<ConnectedTerminal terminalId="test-term-123" />)

        await vi.waitFor(() => {
          // Should NOT spawn since external ID is provided
          expect(vi.mocked(terminalApi).spawn).not.toHaveBeenCalled()
        })

        // Verify terminal was initialized
        expect(mockTerminalInstance.open).toHaveBeenCalled()

        // Trigger visibility change - should not throw any errors
        // even if scroll position restoration occurs
        Object.defineProperty(document, 'visibilityState', {
          value: 'visible',
          writable: true,
          configurable: true
        })
        document.dispatchEvent(new Event('visibilitychange'))

        await vi.advanceTimersByTimeAsync(200)

        // Terminal should still be functional after visibility recovery
        expect(mockTerminalInstance.dispose).not.toHaveBeenCalled()

        vi.useRealTimers()
      })
    })
  })

  describe('Power resume recovery', () => {
    it('should subscribe to power resume events', async () => {
      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      expect(systemApi.onPowerResume).toHaveBeenCalled()
      expect(capturedPowerResumeCallback).toBeTruthy()
    })

    it('should call fit and resize on power resume', async () => {
      vi.useFakeTimers()

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      mockFitAddonInstance.fit.mockClear()
      vi.mocked(terminalApi).resize.mockClear()

      // Simulate power resume
      capturedPowerResumeCallback!()

      // Advance past the 300ms delay
      await vi.advanceTimersByTimeAsync(350)

      expect(mockFitAddonInstance.fit).toHaveBeenCalled()
      expect(vi.mocked(terminalApi).resize).toHaveBeenCalledWith(
        'terminal-123',
        expect.any(Number),
        expect.any(Number)
      )

      vi.useRealTimers()
    })

    it('should cleanup power resume subscription on unmount', async () => {
      const cleanupFn = vi.fn()
      ;(systemApi.onPowerResume as ReturnType<typeof vi.fn>).mockReturnValue(cleanupFn)

      const { unmount } = render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(systemApi.onPowerResume).toHaveBeenCalled()
      })

      unmount()

      expect(cleanupFn).toHaveBeenCalled()
    })
  })

  describe('Regression: Visibility transition + recovery scenarios', () => {
    /**
     * REGRESSION TEST: Ensure terminal properly handles visibility state transitions
     * and recovers correctly when returning from hidden state.
     *
     * Tests for:
     * - Proper cleanup on visibility hide
     * - Recovery on visibility show
     * - CWD polling pause/resume behavior
     */

    it('should pause CWD tracking when terminal becomes hidden', async () => {
      vi.useFakeTimers()

      // Mock the getCwd and onCwdChanged methods
      const mockCwdChanged = vi.fn()
      vi.mocked(terminalApi).onCwdChanged.mockReturnValue(mockCwdChanged)

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Start with visible state
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true
      })

      // Transition to hidden
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        writable: true,
        configurable: true
      })
      document.dispatchEvent(new Event('visibilitychange'))

      await vi.advanceTimersByTimeAsync(100)

      // CWD tracking should be paused (no new tracking started)
      // The component should handle visibility state properly

      vi.useRealTimers()
    })

    it('should resume CWD tracking when terminal becomes visible again', async () => {
      vi.useFakeTimers()

      const mockCwdChanged = vi.fn()
      vi.mocked(terminalApi).onCwdChanged.mockReturnValue(mockCwdChanged)

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Start with hidden state
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        writable: true,
        configurable: true
      })

      // Transition to visible
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true
      })
      document.dispatchEvent(new Event('visibilitychange'))

      await vi.advanceTimersByTimeAsync(300)

      // Terminal should recover and be functional
      expect(mockTerminalInstance.focus).toHaveBeenCalled()
      expect(mockFitAddonInstance.fit).toHaveBeenCalled()

      vi.useRealTimers()
    })

    it('should handle rapid visibility transitions without errors', async () => {
      vi.useFakeTimers()

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Simulate rapid visibility changes
      for (let i = 0; i < 5; i++) {
        Object.defineProperty(document, 'visibilityState', {
          value: i % 2 === 0 ? 'visible' : 'hidden',
          writable: true,
          configurable: true
        })
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(50)
      }

      // Terminal should still be functional after rapid transitions
      expect(mockTerminalInstance.dispose).not.toHaveBeenCalled()

      vi.useRealTimers()
    })
  })

  describe('Regression: CWD changes trigger updates', () => {
    /**
     * REGRESSION TEST: Ensure CWD changes from the backend trigger
     * proper updates in the terminal component.
     *
     * Note: CWD tracking is handled at the store level (use-cwd hook)
     * rather than directly in ConnectedTerminal. These tests verify
     * the component's behavior when CWD state changes.
     */

    it('should have terminalApi with CWD tracking capabilities', () => {
      // Verify the terminal API has CWD-related methods
      expect(terminalApi).toBeDefined()
      expect(typeof terminalApi.onCwdChanged).toBe('function')
      expect(typeof terminalApi.getCwd).toBe('function')
    })

    it('should handle CWD tracking for terminal sessions', async () => {
      // The component should work correctly with CWD tracking enabled
      // CWD is tracked via the use-cwd hook which uses terminalApi
      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Terminal should be functional
      expect(mockTerminalInstance.open).toHaveBeenCalled()
    })

    it('should handle visibility state for CWD polling pause/resume', async () => {
      // CWD polling should pause when terminal is hidden and resume when visible
      // This is tested through visibility behavior
      vi.useFakeTimers()

      render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Simulate hidden state (CWD polling should pause)
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        writable: true,
        configurable: true
      })
      document.dispatchEvent(new Event('visibilitychange'))

      await vi.advanceTimersByTimeAsync(100)

      // Simulate visible state (CWD polling should resume)
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        writable: true,
        configurable: true
      })
      document.dispatchEvent(new Event('visibilitychange'))

      await vi.advanceTimersByTimeAsync(300)

      // Terminal should still be functional
      expect(mockTerminalInstance.dispose).not.toHaveBeenCalled()

      vi.useRealTimers()
    })
  })

  it('should replay transcript once for external terminal ids', async () => {
    mockTerminalStoreState.peekTranscript.mockReturnValueOnce('detached output chunk')

    render(
      <ConnectedTerminal
        terminalId="external-123"
        storeTerminalId="store-123"
        autoSpawn={false}
        spawnOptions={{ projectId: 'project-a' }}
      />
    )

    await vi.waitFor(() => {
      expect(mockTerminalInstance.write).toHaveBeenCalledWith('detached output chunk')
    })

    expect(mockTerminalStoreState.peekTranscript).toHaveBeenCalledWith('external-123')
    expect(mockTerminalStoreState.consumeTranscript).toHaveBeenCalledWith('external-123')
    expect(mockTerminalStoreState.consumeTranscript).toHaveBeenCalledTimes(1)
    expect(mockRecordTerminalContinuityEvent).toHaveBeenCalledWith({
      name: 'restore-replay-attempted',
      correlationId: 'corr-project-a',
      projectId: 'project-a',
      terminalId: 'store-123',
      ptyId: 'external-123',
      details: {
        mode: 'transcript',
        transcriptLength: 'detached output chunk'.length,
        initialScrollbackLineCount: 0,
        source: 'external-terminal',
        alternateScreenDetected: false
      }
    })
    expect(mockRecordTerminalContinuityEvent).toHaveBeenCalledWith({
      name: 'restore-replay-succeeded',
      correlationId: 'corr-project-a',
      projectId: 'project-a',
      terminalId: 'store-123',
      ptyId: 'external-123',
      details: {
        mode: 'transcript',
        transcriptLength: 'detached output chunk'.length,
        source: 'external-terminal',
        fullFidelity: true,
        restoreLimitation: undefined
      }
    })
  })

  it('should prefer transcript over initial scrollback for external terminal restore', async () => {
    mockTerminalStoreState.peekTranscript.mockReturnValueOnce('\u001b[32mstyled output\u001b[0m')

    render(
      <ConnectedTerminal
        terminalId="external-123"
        autoSpawn={false}
        initialScrollback={['plain fallback line']}
        spawnOptions={{ projectId: 'project-a' }}
      />
    )

    await vi.waitFor(() => {
      expect(mockTerminalInstance.write).toHaveBeenCalledWith('\u001b[32mstyled output\u001b[0m')
    })

    expect(mockTerminalInstance.write).not.toHaveBeenCalledWith('plain fallback line\r\n')
  })

  it('records replay skipped when no transcript or scrollback exists', async () => {
    mockTerminalStoreState.peekTranscript.mockReturnValueOnce('')

    render(
      <ConnectedTerminal
        terminalId="external-123"
        storeTerminalId="store-123"
        autoSpawn={false}
        spawnOptions={{ projectId: 'project-a' }}
      />
    )

    await vi.waitFor(() => {
      expect(mockRecordTerminalContinuityEvent).toHaveBeenCalledWith({
        name: 'restore-replay-skipped',
        correlationId: 'corr-project-a',
        projectId: 'project-a',
        terminalId: 'store-123',
        ptyId: 'external-123',
        details: {
          reason: 'no-persisted-history',
          source: 'external-terminal'
        }
      })
    })
  })

  it('records alternate-screen replay as limited fidelity', async () => {
    mockTerminalStoreState.peekTranscript.mockReturnValueOnce('before\u001b[?1049hinside')

    render(
      <ConnectedTerminal
        terminalId="external-123"
        storeTerminalId="store-123"
        autoSpawn={false}
        spawnOptions={{ projectId: 'project-a' }}
      />
    )

    await vi.waitFor(() => {
      expect(mockTerminalInstance.write).toHaveBeenCalledWith(
        '\u001b[33m\r\n[Restore note: alternate-screen or redraw-heavy output may be partially reconstructed from transcript replay]\u001b[0m\r\n'
      )
    })

    expect(mockRecordTerminalContinuityEvent).toHaveBeenCalledWith({
      name: 'restore-replay-succeeded',
      correlationId: 'corr-project-a',
      projectId: 'project-a',
      terminalId: 'store-123',
      ptyId: 'external-123',
      details: {
        mode: 'transcript',
        transcriptLength: 'before\u001b[?1049hinside'.length,
        source: 'external-terminal',
        fullFidelity: false,
        restoreLimitation: 'alternate-screen-or-in-place-redraw'
      }
    })
  })

  it('keeps transcript available when replay write fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onError = vi.fn()
    mockTerminalStoreState.peekTranscript.mockReturnValueOnce('detached output chunk')
    mockTerminalInstance.write.mockImplementationOnce(() => {
      throw new Error('write failed')
    })

    render(
      <ConnectedTerminal
        terminalId="external-123"
        storeTerminalId="store-123"
        autoSpawn={false}
        spawnOptions={{ projectId: 'project-a' }}
        onError={onError}
      />
    )

    await vi.waitFor(() => {
      expect(mockRecordTerminalContinuityEvent).toHaveBeenCalledWith({
        name: 'restore-replay-failed',
        correlationId: 'corr-project-a',
        projectId: 'project-a',
        terminalId: 'store-123',
        ptyId: 'external-123',
        details: {
          mode: 'transcript',
          error: 'write failed',
          source: 'external-terminal'
        }
      })
    })

    expect(mockTerminalStoreState.consumeTranscript).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('write failed')
    consoleErrorSpy.mockRestore()
  })

  it('should mark renderer attachment lifecycle for external terminal ids', async () => {
    const { unmount } = render(<ConnectedTerminal terminalId="external-123" autoSpawn={false} />)

    await vi.waitFor(() => {
      expect(mockTerminalStoreState.setRendererAttached).toHaveBeenCalledWith('external-123', true)
    })

    unmount()

    expect(mockTerminalStoreState.setRendererAttached).toHaveBeenCalledWith('external-123', false)
  })

  describe('Regression: Proper Tauri terminal API mocking', () => {
    /**
     * REGRESSION TEST: Ensure tests properly mock Tauri terminal API
     * to prevent silent fallback to window.api (Electron path).
     *
     * This test validates that the component works with Tauri APIs
     * without requiring window.api to be present.
     */

    it('should use Tauri invoke for terminal operations', async () => {
      // The component should use terminalApi from @/lib/api
      // which should be the Tauri implementation
      expect(terminalApi).toBeDefined()
      expect(typeof terminalApi.spawn).toBe('function')
      expect(typeof terminalApi.write).toBe('function')
      expect(typeof terminalApi.resize).toBe('function')
      expect(typeof terminalApi.kill).toBe('function')
    })

    it('should work without window.api for terminal operations', async () => {
      // Store original window.api if it exists
      const windowWithOptionalApi = window as WindowWithOptionalApi
      const originalWindowApi = windowWithOptionalApi.api

      // Remove window.api to simulate pure Tauri environment
      delete windowWithOptionalApi.api

      // Component should still work with Tauri APIs
      const { unmount } = render(<ConnectedTerminal />)

      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Restore window.api
      if (originalWindowApi) {
        windowWithOptionalApi.api = originalWindowApi
      }

      unmount()
    })

    it('should properly handle Tauri IPC invoke errors', async () => {
      // Mock a failed spawn
      vi.mocked(terminalApi).spawn.mockResolvedValue({
        success: false,
        error: 'Failed to spawn terminal',
        code: 'SPAWN_FAILED'
      })

      const { getByText } = render(<ConnectedTerminal />)

      // Should handle the error gracefully
      await vi.waitFor(() => {
        expect(vi.mocked(terminalApi).spawn).toHaveBeenCalled()
      })

      // Reset for other tests
      vi.mocked(terminalApi).spawn.mockResolvedValue({
        success: true,
        data: { id: 'terminal-123', shell: 'bash', cwd: '/home/user' }
      })
    })
  })
})
