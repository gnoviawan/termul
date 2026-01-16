import '@testing-library/jest-dom'
import { vi, type Mock } from 'vitest'

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

// Mock Electron with explicit named exports for ESM compatibility
// Using vi.mock before any imports with a function that returns the exports
vi.mock('electron', () => {
  const mockApp = {
    whenReady: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    quit: vi.fn(),
    getPath: vi.fn().mockReturnValue('/mock/userdata'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  }

  const mockShell = {
    openExternal: vi.fn()
  }

  const mockIpcMain = {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn()
  }

  const mockContextBridge = {
    exposeInMainWorld: vi.fn()
  }

  const mockIpcRenderer = {
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
    invoke: vi.fn()
  }

  const mockWebUtils: Record<string, unknown> = {}

  // Mock screen module for window-state tests
  const mockDisplay = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workAreaSize: { width: 1920, height: 1040 }
  }

  const mockScreen = {
    getPrimaryDisplay: vi.fn(() => mockDisplay),
    getAllDisplays: vi.fn(() => [mockDisplay])
  }

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
  }) as unknown as Mock & { getAllWindows: Mock; mockClear: () => void }

  // Mock getAllWindows static method
  MockBrowserWindowConstructor.getAllWindows = vi.fn().mockReturnValue([])
  MockBrowserWindowConstructor.mockClear = vi.fn()

  return {
    default: {
      app: mockApp,
      BrowserWindow: MockBrowserWindowConstructor,
      shell: mockShell,
      ipcMain: mockIpcMain,
      contextBridge: mockContextBridge,
      ipcRenderer: mockIpcRenderer,
      webUtils: mockWebUtils,
      screen: mockScreen
    },
    app: mockApp,
    BrowserWindow: MockBrowserWindowConstructor,
    shell: mockShell,
    ipcMain: mockIpcMain,
    contextBridge: mockContextBridge,
    ipcRenderer: mockIpcRenderer,
    webUtils: mockWebUtils,
    screen: mockScreen
  }
})

// Mock micromatch for ESM compatibility
vi.mock('micromatch', () => {
  const mockMatch = vi.fn((list: string[], pattern: string | string[]) => {
    if (typeof pattern === 'string') {
      return list.filter((item) => {
        const regex = new RegExp(
          '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
        )
        return regex.test(item)
      })
    }
    return list
  })

  const mockIsMatch = vi.fn((str: string, pattern: string | string[]) => {
    if (typeof pattern === 'string') {
      const regex = new RegExp(
        '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
      )
      return regex.test(str)
    }
    return false
  })

  return {
    default: {
      match: mockMatch,
      isMatch: mockIsMatch,
      matcher: vi.fn((pattern: string) => {
        const regex = new RegExp(
          '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
        )
        return (str: string) => regex.test(str)
      }),
      scan: vi.fn((pattern: string) => [pattern]),
      parse: vi.fn((pattern: string) => ({ pattern })),
      makeRe: vi.fn((pattern: string) => {
        const regex = new RegExp(
          '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.')
        )
        return regex
      }),
      any: [],
      parseNoExt: vi.fn(() => ({})),
      contains: vi.fn(() => false),
      matchKeys: vi.fn(() => []),
      filter: mockMatch,
      sep: '/',
      isWindows: false,
      unixify: vi.fn((s: string) => s.replace(/\\/g, '/')),
      braceExpand: vi.fn((s: string) => [s]),
      expand: vi.fn((s: string) => [s]),
      globstar: vi.fn(() => '**'),
      // Named exports for ESM
      match: mockMatch,
      isMatch: mockIsMatch
    },
    // Named exports for ESM compatibility
    match: mockMatch,
    isMatch: mockIsMatch
  }
})

// Make mocks available globally for tests
// We need to get the mocked electron module to set it globally
global.mockElectron = mockElectron as any

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

// Mock Element.scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn()

// Mock UI components that cause import issues
vi.mock('@/components/ui/toaster', () => ({
  Toaster: () => null,
  toast: vi.fn(),
  useToast: vi.fn(() => ({ toast: vi.fn() }))
}))

vi.mock('@/stores/app-settings-store', () => {
  // Create mock store state
  const mockState = {
    settings: {
      theme: 'dark' as const,
      fontSize: 14,
      shell: 'powershell',
      terminalFontFamily: 'Cascadia Code, monospace',
      terminalFontSize: 14,
      terminalBufferSize: 1000,
      orphanDetectionEnabled: false,
      orphanDetectionTimeout: 5000
    },
    isLoaded: false,
    setTheme: vi.fn(),
    setFontSize: vi.fn(),
    setShell: vi.fn(),
    setTerminalFontFamily: vi.fn(),
    setTerminalFontSize: vi.fn(),
    setTerminalBufferSize: vi.fn(),
    setSettings: vi.fn(),
    updateSetting: vi.fn(),
    resetToDefaults: vi.fn()
  }

  // Zustand store is a function that can be called with a selector
  const useAppSettingsStore = vi.fn((selector?: (state: typeof mockState) => any) => {
    return selector ? selector(mockState) : mockState
  })

  // Add getState directly for tests that need it
  useAppSettingsStore.getState = vi.fn(() => mockState)

  return {
    useAppSettingsStore,
    useTerminalFontFamily: vi.fn(() => 'Cascadia Code, monospace'),
    useTerminalFontSize: vi.fn(() => 14),
    useTerminalBufferSize: vi.fn(() => 1000)
  }
})

vi.mock('@/stores/worktree-store', () => {
  // Create mock store state
  const mockState = {
    worktrees: [],
    status: 'idle' as const,
    error: null as string | null,
    activeWorktreeId: null as string | null,
    projectExpanded: {} as Record<string, boolean>,
    loadWorktrees: vi.fn(),
    createWorktree: vi.fn(),
    deleteWorktree: vi.fn(),
    updateWorktree: vi.fn(),
    updateStatusCache: vi.fn(),
    setActiveWorktree: vi.fn(),
    toggleProjectExpanded: vi.fn(),
    clearError: vi.fn(),
    clearWorktrees: vi.fn()
  }

  // Zustand store is a function that can be called with a selector
  const useWorktreeStore = vi.fn((selector?: (state: typeof mockState) => any) => {
    return selector ? selector(mockState) : mockState
  })

  // Add getState directly for tests that need it
  useWorktreeStore.getState = vi.fn(() => mockState)

  return {
    useWorktreeStore,
    useWorktrees: vi.fn(() => []),
    useWorktreeCount: vi.fn(() => 0),
    useWorktreeStatus: vi.fn(() => 'clean'),
    useProjectExpanded: vi.fn(() => true),
    useSelectedWorktreeId: vi.fn(() => null),
    useWorktreeActions: vi.fn(() => ({
      selectWorktree: vi.fn(),
      toggleProjectExpanded: vi.fn(),
      deleteWorktree: vi.fn(),
      archiveWorktree: vi.fn()
    }))
  }
})

vi.mock('@/lib/utils', () => ({
  cn: vi.fn((...classes: (string | boolean | undefined | null)[]) => {
    return classes.filter(Boolean).join(' ')
  })
}))

