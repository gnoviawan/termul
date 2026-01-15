import { describe, it, expect, vi, beforeAll } from 'vitest'

// Create mock objects
const mockContextBridge = {
  exposeInMainWorld: vi.fn()
}

const mockIpcRenderer = {
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  invoke: vi.fn()
}

// Mock electron before importing the actual module
vi.mock('electron', () => ({
  contextBridge: mockContextBridge,
  ipcRenderer: mockIpcRenderer,
  default: {
    contextBridge: mockContextBridge,
    ipcRenderer: mockIpcRenderer
  }
}))

// Mock @electron-toolkit/preload
vi.mock('@electron-toolkit/preload', () => ({
  electronAPI: {
    platforms: {
      isWindows: true,
      isMac: false,
      isLinux: false
    }
  }
}))

// Set up context isolation before all tests
beforeAll(() => {
  Object.defineProperty(process, 'contextIsolated', {
    value: true,
    writable: true
  })
})

// Import the preload module once before running tests
beforeAll(async () => {
  await import('./index')
})

describe('Preload Script', () => {
  it('should expose electron API to renderer', () => {
    expect(mockContextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      'electron',
      expect.any(Object)
    )
  })

  it('should expose custom api object to renderer', () => {
    expect(mockContextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      'api',
      expect.any(Object)
    )
  })

  it('should use contextBridge when context is isolated', () => {
    expect(mockContextBridge.exposeInMainWorld).toHaveBeenCalled()
  })
})

describe('Preload API Structure', () => {
  it('should expose api with terminal object to exposeInMainWorld', () => {
    // Find the call that exposes 'api'
    const calls = mockContextBridge.exposeInMainWorld.mock.calls
    const apiCall = calls.find((call: unknown[]) => call[0] === 'api')

    expect(apiCall).toBeDefined()
    expect(apiCall![1]).toHaveProperty('terminal')
    expect(apiCall![1].terminal).toHaveProperty('spawn')
    expect(apiCall![1].terminal).toHaveProperty('write')
    expect(apiCall![1].terminal).toHaveProperty('resize')
    expect(apiCall![1].terminal).toHaveProperty('kill')
    expect(apiCall![1].terminal).toHaveProperty('onData')
    expect(apiCall![1].terminal).toHaveProperty('onExit')
  })

  it('should not expose Node.js require directly', () => {
    // Verify we're not exposing dangerous APIs
    const calls = mockContextBridge.exposeInMainWorld.mock.calls
    const exposedAPIs = calls.map((call: unknown[]) => call[0])

    expect(exposedAPIs).not.toContain('require')
    expect(exposedAPIs).not.toContain('process')
    expect(exposedAPIs).not.toContain('Buffer')
  })
})
