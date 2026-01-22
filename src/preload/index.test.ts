import { describe, it, expect, vi, beforeAll } from 'vitest'

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
    // Get the mocked contextBridge from the global mock
    const contextBridge = (global as any).mockElectron?.contextBridge
    expect(contextBridge?.exposeInMainWorld).toHaveBeenCalled()
  })

  it('should set up IPC listeners', () => {
    // Get the mocked ipcRenderer from the global mock
    const ipcRenderer = (global as any).mockElectron?.ipcRenderer
    expect(ipcRenderer?.on).toHaveBeenCalled()
  })
})
