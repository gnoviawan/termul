import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'

// Mock window.api before any imports that use it
Object.defineProperty(window, 'api', {
  value: {
    persistence: {
      read: vi.fn(() => Promise.resolve({ success: true, data: undefined })),
      write: vi.fn(() => Promise.resolve({ success: true }))
    }
  } as unknown as Window['api'],
  writable: true
})

// Mock project store
vi.mock('@/stores/project-store', () => ({
  useProjectsLoaded: () => true,
  useProjects: () => [],
  useActiveProject: () => undefined,
  useActiveProjectId: () => '',
  useProjectStore: () => ({ activeProjectId: '' }),
  useProjectActions: () => ({
    selectProject: vi.fn(),
    addProject: vi.fn(),
    updateProject: vi.fn(),
    deleteProject: vi.fn(),
    archiveProject: vi.fn(),
    restoreProject: vi.fn(),
    reorderProjects: vi.fn()
  })
}))

// Mock terminal store
vi.mock('@/stores/terminal-store', () => ({
  useAllTerminals: () => [],
  useTerminals: () => [],
  useActiveTerminal: () => undefined,
  useActiveTerminalId: () => '',
  useTerminalStore: () => ({ terminals: [], activeTerminalId: '' }),
  useTerminalActions: () => ({
    selectTerminal: vi.fn(),
    addTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    reorderTerminals: vi.fn(),
    setTerminalPtyId: vi.fn()
  })
}))

// Mock app settings store
vi.mock('@/stores/app-settings-store', () => ({
  useTerminalFontSize: () => 14,
  useDefaultShell: () => '',
  useMaxTerminalsPerProject: () => 10,
  useUpdateAppSetting: () => vi.fn(),
  useAppSettingsStore: () => ({
    getState: () => ({ settings: {}, updateSetting: vi.fn() })
  })
}))

import WorkspaceDashboard from './WorkspaceDashboard'

describe('WorkspaceDashboard', () => {
  afterEach(() => {
    cleanup()
  })

  it('should render empty component (layout handles all rendering)', () => {
    const { container } = render(<WorkspaceDashboard />)

    // WorkspaceDashboard is now a minimal route target component
    // All actual UI is rendered by WorkspaceLayout.tsx
    expect(container.firstChild).toBe(null)
  })
})
