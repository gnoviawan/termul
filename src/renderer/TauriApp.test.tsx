import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import TauriApp from './TauriApp'
import { CONTEXT_BAR_SETTINGS_KEY } from '@/types/settings'

const { mockPersistenceRead } = vi.hoisted(() => ({
  mockPersistenceRead: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: mockPersistenceRead
  }
}))

vi.mock('@/hooks/use-window-state', () => ({
  useWindowState: () => false
}))

vi.mock('./layouts/WorkspaceLayout', () => ({
  default: () => <div>Workspace Layout</div>
}))

vi.mock('./pages/WorkspaceDashboard', () => ({
  default: () => null
}))

vi.mock('./pages/ProjectSettings', () => ({
  default: () => null
}))

vi.mock('./pages/AppPreferences', () => ({
  default: () => null
}))

vi.mock('./pages/WorkspaceSnapshots', () => ({
  default: () => null
}))

vi.mock('./pages/NotFound', () => ({
  default: () => null
}))

vi.mock('./hooks/useTerminalAutoSave', () => ({
  useTerminalAutoSave: () => undefined
}))

vi.mock('./hooks/use-terminal-restore', () => ({
  useTerminalRestore: () => undefined
}))

vi.mock('./hooks/use-cwd', () => ({
  useCwd: () => undefined
}))

vi.mock('./hooks/use-git-branch', () => ({
  useGitBranch: () => undefined
}))

vi.mock('./hooks/use-git-status', () => ({
  useGitStatus: () => undefined
}))

vi.mock('./hooks/use-exit-code', () => ({
  useExitCode: () => undefined
}))

vi.mock('./hooks/use-app-settings', () => ({
  useAppSettingsLoader: () => undefined
}))

vi.mock('./hooks/use-keyboard-shortcuts', () => ({
  useKeyboardShortcutsLoader: () => undefined
}))

vi.mock('./hooks/use-projects-persistence', () => ({
  useProjectsLoader: () => undefined,
  useProjectsAutoSave: () => undefined
}))

vi.mock('./hooks/use-menu-updater-listener', () => ({
  useMenuUpdaterListener: () => undefined
}))

vi.mock('./hooks/use-updater', () => ({
  useUpdateCheck: () => undefined
}))

vi.mock('./components/UpdateAvailableToast', () => ({
  useUpdateToast: () => undefined
}))

vi.mock('./hooks/use-visibility-state', () => ({
  useVisibilityState: () => undefined
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockPersistenceRead.mockResolvedValue({
    success: false,
    error: 'Key not found',
    code: 'KEY_NOT_FOUND'
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TauriApp', () => {
  it('loads context bar settings on mount', async () => {
    render(<TauriApp />)

    await waitFor(() => {
      expect(mockPersistenceRead).toHaveBeenCalledWith(CONTEXT_BAR_SETTINGS_KEY)
    })
  })
})
