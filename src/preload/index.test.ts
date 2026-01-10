import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock context bridge
const mockExposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: mockExposeInMainWorld
  }
}))

vi.mock('@electron-toolkit/preload', () => ({
  electronAPI: { ipcRenderer: { on: vi.fn(), send: vi.fn() } }
}))

describe('Preload Script', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Simulate context isolation enabled
    Object.defineProperty(process, 'contextIsolated', {
      value: true,
      writable: true
    })
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('should expose electron API to renderer', async () => {
    await import('./index')

    expect(mockExposeInMainWorld).toHaveBeenCalledWith(
      'electron',
      expect.any(Object)
    )
  })

  it('should expose custom api object to renderer', async () => {
    await import('./index')

    expect(mockExposeInMainWorld).toHaveBeenCalledWith(
      'api',
      expect.any(Object)
    )
  })

  it('should use contextBridge when context is isolated', async () => {
    await import('./index')

    expect(mockExposeInMainWorld).toHaveBeenCalled()
  })
})

describe('Preload API Structure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(process, 'contextIsolated', {
      value: true,
      writable: true
    })
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('should expose api with terminal object to exposeInMainWorld', async () => {
    await import('./index')

    // Find the call that exposes 'api'
    const apiCall = mockExposeInMainWorld.mock.calls.find(
      (call: unknown[]) => call[0] === 'api'
    )

    expect(apiCall).toBeDefined()
    expect(apiCall![1]).toHaveProperty('terminal')
    expect(apiCall![1].terminal).toHaveProperty('spawn')
    expect(apiCall![1].terminal).toHaveProperty('write')
    expect(apiCall![1].terminal).toHaveProperty('resize')
    expect(apiCall![1].terminal).toHaveProperty('kill')
    expect(apiCall![1].terminal).toHaveProperty('onData')
    expect(apiCall![1].terminal).toHaveProperty('onExit')
  })

  it('should not expose Node.js require directly', async () => {
    await import('./index')

    // Verify we're not exposing dangerous APIs
    const calls = mockExposeInMainWorld.mock.calls
    const exposedAPIs = calls.map((call: unknown[]) => call[0])

    expect(exposedAPIs).not.toContain('require')
    expect(exposedAPIs).not.toContain('process')
    expect(exposedAPIs).not.toContain('Buffer')
  })
})
