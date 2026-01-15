import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock instances for verification - will be set by vitest.mock in setup
declare global {
  var mockElectron: any
}

describe('Main Process - createWindow', () => {
  // Import module once at the beginning
  beforeAll(async () => {
    await import('./index')
  })

  // Note: We don't use beforeEach with vi.clearAllMocks() here because it would
  // clear the mock state needed by the "Main Process - App Lifecycle" tests
  // Instead, individual tests can clear mocks if needed
  beforeEach(() => {
    // Clear BrowserWindow mock between tests so each test gets a fresh instance
    global.mockElectron.BrowserWindow.mockClear()
  })

  it('should create a BrowserWindow with correct dimensions', async () => {
    const { createWindow } = await import('./index')

    createWindow()

    expect(global.mockElectron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600
      })
    )
  })

  it('should configure security settings correctly', async () => {
    const { createWindow } = await import('./index')

    createWindow()

    expect(global.mockElectron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          contextIsolation: true,
          nodeIntegration: false
        })
      })
    )
  })

  it('should set dark background color', async () => {
    const { createWindow } = await import('./index')

    createWindow()

    expect(global.mockElectron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundColor: '#0f0f0f'
      })
    )
  })

  it('should register ready-to-show handler', async () => {
    const { createWindow } = await import('./index')

    createWindow()

    // Get the mock instance that was created
    const mockInstance = global.mockElectron.BrowserWindow.mock.results[0]?.value
    expect(mockInstance?.on).toHaveBeenCalledWith('ready-to-show', expect.any(Function))
  })

  it('should configure window open handler', async () => {
    const { createWindow } = await import('./index')

    createWindow()

    // Get the mock instance that was created
    const mockInstance = global.mockElectron.BrowserWindow.mock.results[0]?.value
    expect(mockInstance?.webContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function))
  })

  it('should return the created BrowserWindow instance', async () => {
    const { createWindow } = await import('./index')

    const result = createWindow()

    expect(result).toBeDefined()
    expect(result.on).toBeDefined()
  })
})

describe('Main Process - Window Configuration', () => {
  beforeEach(() => {
    // Only clear BrowserWindow mock between tests
    global.mockElectron.BrowserWindow.mockClear()
  })

  it('should start hidden and show when ready', async () => {
    const { createWindow } = await import('./index')

    createWindow()

    expect(global.mockElectron.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        show: false
      })
    )
  })
})

describe('Main Process - App Lifecycle', () => {
  // Note: window-all-closed handler is registered at module level (line 124)
  // It runs once when the module is first imported
  // We don't clear mocks here to preserve the module-level registration calls
  it('should register window-all-closed handler', async () => {
    // The module-level code registers this handler
    // Check if it was called during initial module load
    const calls = global.mockElectron.app.on.mock.calls
    const windowAllClosedCall = calls.find(
      (call: unknown[]) => call[0] === 'window-all-closed'
    )

    expect(windowAllClosedCall).toBeDefined()
    expect(windowAllClosedCall?.[1]).toBeInstanceOf(Function)
  })
})
