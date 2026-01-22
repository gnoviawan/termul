import '@testing-library/jest-dom'
import { vi, type Mock } from 'vitest'
import * as electronMock from 'electron'


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
  webUtils: {},
  screen: {
    getPrimaryDisplay: vi.fn(() => ({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workAreaSize: { width: 1920, height: 1040 }
    })),
    getAllDisplays: vi.fn(() => [{
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workAreaSize: { width: 1920, height: 1040 }
    }])
  }
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
      globstar: vi.fn(() => '**')
    },
    // Named exports for ESM compatibility
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
    globstar: vi.fn(() => '**')
  }
})


// Make mocks available globally for tests
// Use the current electron mock so tests share the same instance
const electronModule = (electronMock as unknown as { default?: typeof mockElectron })
const electronExports = (electronModule.default ?? electronModule) as typeof mockElectron

Object.assign(mockElectron, electronExports)

global.mockElectron = mockElectron as typeof electronExports


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
      terminalFontFamily: 'Menlo, Monaco, "Courier New", monospace',
      terminalFontSize: 14,
      terminalBufferSize: 10000,
      defaultShell: '',
      defaultProjectColor: 'blue',
      maxTerminalsPerProject: 10,
      orphanDetectionEnabled: true,
      orphanDetectionTimeout: 600000,
      emergencyModeEnabled: false
    },
    isLoaded: false,
    setSettings: vi.fn(),
    updateSetting: vi.fn(),
    resetToDefaults: vi.fn()
  }


  // Zustand store is a function that can be called with a selector
  const useAppSettingsStore = vi.fn((selector?: (state: typeof mockState) => any) => {
    return selector ? selector(mockState) : mockState
  }) as unknown as ((selector?: (state: typeof mockState) => any) => any) & {
    getState: () => typeof mockState
    setState: (partial: Partial<typeof mockState>) => void
  }

  useAppSettingsStore.getState = () => mockState
  useAppSettingsStore.setState = (partial) => {
    Object.assign(mockState, partial)
  }


  return {
    useAppSettingsStore,
    useTerminalFontFamily: () => mockState.settings.terminalFontFamily,
    useTerminalFontSize: () => mockState.settings.terminalFontSize,
    useDefaultShell: () => mockState.settings.defaultShell,
    useMaxTerminalsPerProject: () => mockState.settings.maxTerminalsPerProject,
    useTerminalBufferSize: () => mockState.settings.terminalBufferSize,
    useUpdateAppSetting: () => mockState.updateSetting
  }

})

vi.mock('@/stores/worktree-store', () => {
  // Create mock store state
  const mockState = {
    worktrees: new Map(),
    statusCache: new Map(),
    error: null as string | null,
    activeWorktreeId: null as string | null,
    expandedProjects: new Set<string>(),
    selectedWorktreeId: null as string | null,
    isLoading: false,
    isRefreshingStatus: false,
    filterStatus: 'all' as const,
    lastStatusUpdate: 0,
    loadWorktrees: vi.fn(),
    createWorktree: vi.fn(),
    deleteWorktree: vi.fn(),
    archiveWorktree: vi.fn(),
    updateWorktreeStatus: vi.fn(),
    setActiveWorktree: vi.fn(),
    setSelectedWorktree: vi.fn(),
    toggleProjectExpanded: vi.fn(),
    setProjectExpanded: vi.fn(),
    refreshStatus: vi.fn(),
    clearError: vi.fn(),
    initializeEventListeners: vi.fn(() => vi.fn())
  }


  // Zustand store is a function that can be called with a selector
  const useWorktreeStore = vi.fn((selector?: (state: typeof mockState) => any) => {
    return selector ? selector(mockState) : mockState
  }) as unknown as ((selector?: (state: typeof mockState) => any) => any) & {
    getState: () => typeof mockState
    setState: (partial: Partial<typeof mockState>) => void
  }

  useWorktreeStore.getState = () => mockState
  useWorktreeStore.setState = (partial) => {
    Object.assign(mockState, partial)
  }


  return {
    useWorktreeStore,
    useWorktrees: vi.fn(() => []),
    useWorktreeCount: vi.fn(() => 0),
    useWorktreeStatus: vi.fn(() => ({
      dirty: false,
      ahead: 0,
      behind: 0,
      conflicted: false,
      currentBranch: 'main',
      updatedAt: Date.now()
    })),
    useProjectExpanded: vi.fn(() => true),
    useSelectedWorktreeId: vi.fn(() => null),
    useWorktreeActions: vi.fn(() => ({
      createWorktree: vi.fn(),
      deleteWorktree: vi.fn(),
      archiveWorktree: vi.fn(),
      updateWorktreeStatus: vi.fn(),
      setActiveWorktree: vi.fn(),
      setSelectedWorktree: vi.fn(),
      toggleProjectExpanded: vi.fn(),
      setProjectExpanded: vi.fn(),
      refreshStatus: vi.fn(),
      loadWorktrees: vi.fn(),
      clearError: vi.fn(),
      initializeEventListeners: vi.fn()
    }))
  }

})

vi.mock('@/lib/utils', () => ({
  cn: vi.fn((...classes: (string | boolean | undefined | null)[]) => {
    return classes.filter(Boolean).join(' ')
  })
}))

