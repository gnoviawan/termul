import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock instances for verification
const mockWebContents = {
  setWindowOpenHandler: vi.fn(),
  on: vi.fn(),
  send: vi.fn()
}

const mockWindowInstance = {
  on: vi.fn(),
  loadURL: vi.fn(),
  loadFile: vi.fn(),
  show: vi.fn(),
  webContents: mockWebContents
}

// Use function constructor for BrowserWindow mock
const MockBrowserWindow = vi.fn(function(this: typeof mockWindowInstance) {
  Object.assign(this, mockWindowInstance)
  return this
}) as unknown as typeof import('electron').BrowserWindow

// Add static methods - cast to any to avoid complex type issues with vitest mocks
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(MockBrowserWindow as any).getAllWindows = vi.fn().mockReturnValue([])

const mockApp = {
  whenReady: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  quit: vi.fn()
}

const mockShell = {
  openExternal: vi.fn()
}

const mockElectronApp = {
  setAppUserModelId: vi.fn()
}

const mockOptimizer = {
  watchWindowShortcuts: vi.fn()
}

const mockIs = {
  dev: false
}

// Mock Electron modules
vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: MockBrowserWindow,
  shell: mockShell
}))

vi.mock('@electron-toolkit/utils', () => ({
  electronApp: mockElectronApp,
  optimizer: mockOptimizer,
  is: mockIs
}))

describe('Main Process - createWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('should create a BrowserWindow with correct dimensions', async () => {
    const { createWindow } = await import('./index')

    createWindow()

    expect(MockBrowserWindow).toHaveBeenCalledWith(
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

    expect(MockBrowserWindow).toHaveBeenCalledWith(
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

    expect(MockBrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundColor: '#0f0f0f'
      })
    )
  })

  it('should register ready-to-show handler', async () => {
    const { createWindow } = await import('./index')

    createWindow()

    expect(mockWindowInstance.on).toHaveBeenCalledWith('ready-to-show', expect.any(Function))
  })

  it('should configure window open handler', async () => {
    const { createWindow } = await import('./index')

    createWindow()

    expect(mockWebContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function))
  })

  it('should return the created BrowserWindow instance', async () => {
    const { createWindow } = await import('./index')

    const result = createWindow()

    expect(result).toBeDefined()
    expect(result.on).toBe(mockWindowInstance.on)
  })
})

describe('Main Process - Window Configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should auto-hide menu bar', async () => {
    const { createWindow } = await import('./index')

    createWindow()

    expect(MockBrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        autoHideMenuBar: true
      })
    )
  })

  it('should start hidden and show when ready', async () => {
    const { createWindow } = await import('./index')

    createWindow()

    expect(MockBrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        show: false
      })
    )
  })
})

describe('Main Process - App Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('should register window-all-closed handler', async () => {
    await import('./index')

    expect(mockApp.on).toHaveBeenCalledWith('window-all-closed', expect.any(Function))
  })
})
