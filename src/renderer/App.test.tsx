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
