import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import AppPreferences from './AppPreferences'

/**
 * GH-539: the App Preferences switch/select are the ONLY write path for the
 * auto-save settings. These tests pin the wiring (click → store value), which
 * no auto-save unit test can reach because they inject settings directly.
 */

const mockWriteDebounced = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/api', () => ({
  acpApi: { setTurnTimeout: vi.fn().mockResolvedValue({ success: true }) },
  logApi: {
    revealLogDir: vi.fn(),
    exportLogFile: vi.fn(),
    copyLogContents: vi.fn(),
    exportLogToDefault: vi.fn()
  },
  shellApi: {
    getAvailableShells: vi.fn().mockResolvedValue({
      success: true,
      data: { default: null, available: [] }
    })
  },
  terminalApi: { updateOrphanDetection: vi.fn().mockResolvedValue({ success: true }) },
  persistenceApi: {
    read: vi.fn().mockResolvedValue({ success: true, data: null }),
    write: vi.fn(),
    writeDebounced: (...args: unknown[]) => mockWriteDebounced(...args)
  }
}))

vi.mock('@/lib/tauri-updater-api', () => ({
  isAurUpdateMode: () => false
}))

vi.mock('@/stores/updater-store', () => ({
  useUpdaterState: () => ({
    isChecking: false,
    updateAvailable: false,
    version: '0.4.8',
    lastChecked: null,
    autoUpdateEnabled: false,
    skippedVersion: null,
    error: null,
    isManualUpdateMode: false,
    updateChannel: 'stable'
  }),
  useUpdaterActions: () => ({
    checkForUpdates: vi.fn(),
    installAndRestart: vi.fn(),
    setAutoUpdateEnabled: vi.fn(),
    setUpdateChannel: vi.fn()
  })
}))

vi.mock('@/stores/keyboard-shortcuts-store', () => ({
  useKeyboardShortcutsStore: vi.fn((selector: (s: { shortcuts: unknown[] }) => unknown) =>
    selector({ shortcuts: [] })
  )
}))

const mockResetAllShortcuts = vi.fn().mockResolvedValue(undefined)
vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  useUpdateShortcut: () => vi.fn(),
  useResetShortcut: () => vi.fn(),
  useResetAllShortcuts: () => mockResetAllShortcuts
}))

vi.mock('@/components/settings/AcpAgentsSettings', () => ({
  AcpAgentsSettings: () => null
}))

vi.mock('@/components/settings/McpServersSettings', () => ({
  McpServersSettings: () => null
}))

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <AppPreferences />
    </MemoryRouter>
  )
}

describe('AppPreferences editor auto-save controls (GH-539)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppSettingsStore.setState({ settings: { ...DEFAULT_APP_SETTINGS }, isLoaded: true })
  })

  it('toggling the auto-save switch writes editorAutoSave (with correct negation)', async () => {
    renderPage()

    const toggle = await screen.findByRole('switch', { name: 'Enable auto save' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(toggle)
    await waitFor(() => {
      expect(useAppSettingsStore.getState().settings.editorAutoSave).toBe(true)
    })
    expect(mockWriteDebounced).toHaveBeenCalled()

    fireEvent.click(toggle)
    await waitFor(() => {
      expect(useAppSettingsStore.getState().settings.editorAutoSave).toBe(false)
    })
  })

  it('changing the delay select writes editorAutoSaveDelayMs and is disabled while off', async () => {
    renderPage()

    const select = await screen.findByLabelText('Auto save delay')
    expect(select).toBeDisabled()

    fireEvent.click(screen.getByRole('switch', { name: 'Enable auto save' }))
    await waitFor(() => {
      expect(screen.getByLabelText('Auto save delay')).toBeEnabled()
    })

    fireEvent.change(screen.getByLabelText('Auto save delay'), { target: { value: '2000' } })
    await waitFor(() => {
      expect(useAppSettingsStore.getState().settings.editorAutoSaveDelayMs).toBe(2000)
    })
  })
})
