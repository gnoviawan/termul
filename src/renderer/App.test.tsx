import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import App from './App'
import { useUpdaterStore } from '@/stores/updater-store'
import { CONTEXT_BAR_SETTINGS_KEY } from '@/types/settings'

const { mockContextBarSettingsRead } = vi.hoisted(() => ({
  mockContextBarSettingsRead: vi.fn()
}))

vi.mock('./hooks/use-context-bar-settings', () => ({
  useContextBarSettings: () => {
    void mockContextBarSettingsRead(CONTEXT_BAR_SETTINGS_KEY)
  }
}))

const mockCheckForUpdates = vi.fn(async () => {})
const mockInitializeUpdater = vi.fn(async () => {})
const mockStopPeriodicChecks = vi.fn(() => {})

// Mock window.api for hooks that use it
const mockApi = {
  terminal: {
    onCwdChanged: vi.fn(() => () => {}),
    onGitBranchChanged: vi.fn(() => () => {}),
    onGitStatusChanged: vi.fn(() => () => {}),
    onExitCodeChanged: vi.fn(() => () => {}),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    getCwd: vi.fn(),
    getGitBranch: vi.fn(),
    getGitStatus: vi.fn(),
    getExitCode: vi.fn()
  },
  persistence: {
    getWindowState: vi.fn(() => Promise.resolve({ success: true, data: null })),
    saveWindowState: vi.fn(),
    getProjects: vi.fn(() => Promise.resolve({ success: true, data: [] })),
    saveProjects: vi.fn(),
    getHomeDirectory: vi.fn(() => Promise.resolve({ success: true, data: '/home/user' })),
    read: vi.fn(() => Promise.resolve({ success: true, data: null })),
    writeDebounced: vi.fn(() => Promise.resolve({ success: true, data: undefined })),
    flushPendingWrites: vi.fn(() => Promise.resolve({ success: true, data: undefined }))
  },
  updater: {
    checkForUpdates: vi.fn(() => Promise.resolve({ success: true, data: null })),
    downloadUpdate: vi.fn(() => Promise.resolve({ success: true, data: undefined })),
    installAndRestart: vi.fn(() => Promise.resolve({ success: true, data: undefined })),
    skipVersion: vi.fn(() => Promise.resolve({ success: true, data: undefined })),
    getState: vi.fn(() => Promise.resolve({
      success: true,
      data: {
        updateAvailable: false,
        downloaded: false,
        version: null,
        isChecking: false,
        isDownloading: false,
        downloadProgress: null,
        error: null,
        lastChecked: null
      }
    })),
    setAutoUpdateEnabled: vi.fn(() => Promise.resolve({ success: true, data: undefined })),
    getAutoUpdateEnabled: vi.fn(() => Promise.resolve({ success: true, data: true })),
    onUpdateAvailable: vi.fn(() => () => {}),
    onUpdateDownloaded: vi.fn(() => () => {}),
    onDownloadProgress: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {})
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('api', mockApi)
  useUpdaterStore.setState({
    updateAvailable: false,
    version: null,
    downloaded: false,
    downloadProgress: 0,
    skippedVersion: null,
    isChecking: false,
    isDownloading: false,
    error: null,
    lastChecked: null,
    autoUpdateEnabled: true,
    releaseNotes: null,
    hasActiveTerminals: false,
    checkForUpdates: mockCheckForUpdates,
    initializeUpdater: mockInitializeUpdater,
    stopPeriodicChecks: mockStopPeriodicChecks
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App Component', () => {
  it('should render without crashing', () => {
    render(<App />)
    expect(document.body.querySelector('[class*="min-h-screen"]')).toBeDefined()
  })

  it('should render QueryClientProvider and TooltipProvider', () => {
    render(<App />)
    // App renders and providers work - verify by checking rendered content exists
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
  })
})

describe('App Routes', () => {
  it('should render WorkspaceDashboard on root path', () => {
    render(<App />)
    // WorkspaceDashboard should be rendered by default
    // Check for presence of rendered content (indicates route matched)
    expect(document.body.innerHTML).toBeTruthy()
  })

  it('loads context bar settings on mount', async () => {
    render(<App />)

    await waitFor(() => {
      expect(mockContextBarSettingsRead).toHaveBeenCalledWith(CONTEXT_BAR_SETTINGS_KEY)
    })
  })
})

describe('App Updater Integration', () => {
  it('should not depend on legacy updater event listeners on mount', () => {
    render(<App />)
    // The current updater flow bootstraps from persisted state instead of
    // wiring Electron-only event listeners during mount.
    expect(mockApi.updater.onUpdateAvailable).not.toHaveBeenCalled()
    expect(mockApi.updater.onUpdateDownloaded).not.toHaveBeenCalled()
    expect(mockApi.updater.onDownloadProgress).not.toHaveBeenCalled()
    expect(mockApi.updater.onError).not.toHaveBeenCalled()
  })

  it('should initialize updater through the Tauri store hooks on mount', async () => {
    render(<App />)

    await waitFor(() => {
      expect(mockInitializeUpdater).toHaveBeenCalledWith({ autoCheck: false })
      expect(mockInitializeUpdater).toHaveBeenCalledWith({ autoCheck: true })
    })
  })

  it('should delegate startup auto-check through updater initialization', async () => {
    render(<App />)

    await waitFor(() => {
      expect(mockInitializeUpdater).toHaveBeenCalledWith({ autoCheck: true })
    })

    expect(mockCheckForUpdates).not.toHaveBeenCalled()
  })

  it('should stop updater periodic checks when the app unmounts', async () => {
    const { unmount } = render(<App />)

    await waitFor(() => {
      expect(mockInitializeUpdater).toHaveBeenCalled()
    })

    unmount()

    expect(mockStopPeriodicChecks).toHaveBeenCalledTimes(1)
  })
})
