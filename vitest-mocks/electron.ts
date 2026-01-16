import { vi } from 'vitest'

// Create BrowserWindow mock constructor
const MockBrowserWindowConstructor = vi.fn(function() {
  return {
    on: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    show: vi.fn(),
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      send: vi.fn()
    }
  }
}) as any

// Mock getAllWindows static method
MockBrowserWindowConstructor.getAllWindows = vi.fn().mockReturnValue([])
MockBrowserWindowConstructor.mockClear = vi.fn()

// Mock screen module for window-state tests
const mockDisplay = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workAreaSize: { width: 1920, height: 1040 }
}

const mockScreen = {
  getPrimaryDisplay: vi.fn(() => mockDisplay),
  getAllDisplays: vi.fn(() => [mockDisplay])
}

// Export all electron APIs as named exports
export const app = {
  whenReady: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  quit: vi.fn(),
  getPath: vi.fn().mockReturnValue('/mock/userdata'),
  getVersion: vi.fn().mockReturnValue('1.0.0')
}

export const BrowserWindow = MockBrowserWindowConstructor

export const shell = {
  openExternal: vi.fn()
}

export const ipcMain = {
  handle: vi.fn(),
  on: vi.fn(),
  removeHandler: vi.fn()
}

export const contextBridge = {
  exposeInMainWorld: vi.fn()
}

export const ipcRenderer = {
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
  invoke: vi.fn()
}

export const webUtils: Record<string, unknown> = {}

export const screen = mockScreen

// Default export
export default {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  contextBridge,
  ipcRenderer,
  webUtils,
  screen
}
