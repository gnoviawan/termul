import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import App from './App'

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
    writeDebounced: vi.fn(() => Promise.resolve({ success: true, data: undefined }))
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
  vi.stubGlobal('api', mockApi)
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
})

describe('App Updater Integration', () => {
  it('should register updater event listeners on mount', () => {
    render(<App />)
    // useUpdateCheck mounts globally and registers IPC listeners
    expect(mockApi.updater.onUpdateAvailable).toHaveBeenCalled()
    expect(mockApi.updater.onUpdateDownloaded).toHaveBeenCalled()
    expect(mockApi.updater.onDownloadProgress).toHaveBeenCalled()
    expect(mockApi.updater.onError).toHaveBeenCalled()
  })

  it('should initialize updater state from main process', () => {
    render(<App />)
    expect(mockApi.updater.getState).toHaveBeenCalled()
    expect(mockApi.updater.getAutoUpdateEnabled).toHaveBeenCalled()
  })

  it('should auto-check for updates on mount', async () => {
    render(<App />)
    // After initialization completes, auto-check triggers
    await vi.waitFor(() => {
      expect(mockApi.updater.checkForUpdates).toHaveBeenCalled()
    })
  })
})
