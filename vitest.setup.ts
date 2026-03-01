import '@testing-library/jest-dom'
import { vi, type Mock } from 'vitest'
import React from 'react'

// Type definition for mock electron object
export interface MockElectron {
  app: {
    whenReady: Mock
    on: Mock
    quit: Mock
    getPath: Mock
    getVersion: Mock
  }
  BrowserWindow: Mock & { getAllWindows: Mock; mockClear: () => void }
  shell: {
    openExternal: Mock
  }
  ipcMain: {
    handle: Mock
    on: Mock
    removeHandler: Mock
  }
  contextBridge: {
    exposeInMainWorld: Mock
  }
  ipcRenderer: {
    on: Mock
    removeListener: Mock
    send: Mock
    invoke: Mock
  }
  webUtils: Record<string, unknown>
}

// Extend global type
declare global {
  var mockElectron: MockElectron
}

// Mock Electron modules FIRST - before any other code that might import electron
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
}) as unknown as Mock & { getAllWindows: Mock }

// Mock getAllWindows static method
MockBrowserWindowConstructor.getAllWindows = vi.fn().mockReturnValue([])

const mockElectron = {
  app: {
    whenReady: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    quit: vi.fn(),
    getPath: vi.fn().mockReturnValue('/mock/userdata'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: MockBrowserWindowConstructor,
  shell: {
    openExternal: vi.fn()
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn()
  },
  contextBridge: {
    exposeInMainWorld: vi.fn()
  },
  ipcRenderer: {
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
    invoke: vi.fn()
  },
  webUtils: {}
}

vi.mock('electron', () => ({
  default: mockElectron,
  ...mockElectron
}))

// Make mocks available globally for tests
global.mockElectron = mockElectron

// Mock window.matchMedia for sonner/toast components
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  })
})

// Mock ResizeObserver
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverMock

vi.mock('electron-updater', () => ({
  autoUpdater: {
    setFeedURL: vi.fn(),
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    getAutoUpdater: vi.fn()
  }
}))

// Mock @electron-toolkit/utils
vi.mock('@electron-toolkit/utils', () => ({
  electronApp: {
    setAppUserModelId: vi.fn()
  },
  optimizer: {
    watchWindowShortcuts: vi.fn()
  },
  is: {
    dev: false
  }
}))

// Mock internal services that are imported by main/index
vi.mock('../main/ipc/terminal.ipc', () => ({
  registerTerminalIpc: vi.fn()
}))

vi.mock('../main/ipc/dialog.ipc', () => ({
  registerDialogIpc: vi.fn()
}))

vi.mock('../main/ipc/shell.ipc', () => ({
  registerShellIpc: vi.fn()
}))

vi.mock('../main/ipc/persistence.ipc', () => ({
  registerPersistenceIpc: vi.fn()
}))

vi.mock('../main/ipc/system.ipc', () => ({
  registerSystemIpc: vi.fn()
}))

vi.mock('../main/ipc/updater.ipc', () => ({
  initRegisterUpdaterIpc: vi.fn(),
  setUpdaterWindow: vi.fn()
}))

vi.mock('../main/services/persistence-service', () => ({
  flushPendingWrites: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../main/services/pty-manager', () => ({
  resetDefaultPtyManager: vi.fn()
}))

vi.mock('../main/services/window-state', () => ({
  loadWindowState: vi.fn().mockResolvedValue(undefined),
  trackWindowState: vi.fn()
}))

vi.mock('../main/menu', () => ({
  setupMenu: vi.fn(),
  setMainWindow: vi.fn()
}))

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  watchImmediate: vi.fn()
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
  confirm: vi.fn()
}))

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(),
  writeText: vi.fn()
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  createStore: vi.fn()
}))

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(),
  version: vi.fn(),
  type: vi.fn(),
  arch: vi.fn(),
  tempdir: vi.fn(),
  homedir: vi.fn()
}))

// Mock react-virtuoso to render items directly in tests
vi.mock('react-virtuoso', () => {
  const VirtuosoComponent = React.forwardRef(
    (
      {
        data,
        itemContent
      }: {
        data: unknown[]
        itemContent: (index: number, item: unknown) => React.JSX.Element
      },
      _ref: React.Ref<unknown>
    ) => {
      return React.createElement(
        'div',
        { 'data-testid': 'virtuoso-scroller', 'data-virtuoso-scroller': 'true' },
        React.createElement(
          'div',
          { 'data-testid': 'virtuoso-item-list' },
          data.map((item, index) =>
            React.createElement('div', { key: index }, itemContent(index, item))
          )
        )
      )
    }
  )
  VirtuosoComponent.displayName = 'Virtuoso'
  return { Virtuoso: VirtuosoComponent }
})

