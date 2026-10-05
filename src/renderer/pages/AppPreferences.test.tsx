import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import { AppPreferencesModal } from './AppPreferences'

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

// Story 8 (web honesty): the Updates + Diagnostics desktop-only controls
// are gated with isTauriContext(). Mutable ref defaults to desktop so the
// existing control tests keep running in desktop mode; the web-mode tests
// flip it.
const { tauriRef } = vi.hoisted(() => ({ tauriRef: { current: true as boolean } }))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => tauriRef.current
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

vi.mock('@/stores/keyboard-shortcuts-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/keyboard-shortcuts-store')>()
  return {
    ...actual,
    useKeyboardShortcutsStore: vi.fn((selector: (s: { shortcuts: unknown[] }) => unknown) =>
      selector({
        shortcuts: [
          {
            id: 'commandPalette',
            label: 'Command Palette',
            description: 'Open the command palette for quick actions',
            defaultKey: 'ctrl+k'
          },
          {
            id: 'newTerminal',
            label: 'Agent Launcher',
            description: 'Show the agent launcher prompt in the active pane',
            defaultKey: 'ctrl+t'
          },
          {
            id: 'newBrowserTab',
            label: 'New Browser Tab',
            description: 'Create a new browser tab',
            defaultKey: 'ctrl+shift+n'
          }
        ]
      })
    )
  }
})

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
  useSettingsModalStore.setState({ view: 'app' })
  return render(
    <MemoryRouter>
      <AppPreferencesModal />
    </MemoryRouter>
  )
}

describe('AppPreferences editor auto-save controls (GH-539)', () => {
  beforeEach(() => {
    tauriRef.current = true
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

// Story 8 (web honesty) → issue #843: desktop-only Preferences entries are
// now HIDDEN on web (not disabled-with-title). Copy Log Contents stays
// available (works on web).
describe('AppPreferences web honesty gates (Story 8)', () => {
  beforeEach(() => {
    tauriRef.current = true
    vi.clearAllMocks()
    useAppSettingsStore.setState({ settings: { ...DEFAULT_APP_SETTINGS }, isLoaded: true })
  })

  function renderWeb(): void {
    tauriRef.current = false
    renderPage()
  }

  it('hides the whole Updates control set on web and shows the server version note', async () => {
    renderWeb()

    expect(screen.queryByRole('button', { name: /Check for Updates/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Release Channel')).not.toBeInTheDocument()
    expect(screen.queryByText('Auto-update')).not.toBeInTheDocument()
    expect(await screen.findByText(/Server Version/i, { selector: 'label' })).toBeInTheDocument()
    expect(
      screen.getByText(/web client is served by the termul-server and updates together with it/i)
    ).toBeInTheDocument()
  })

  it('hides Reveal Log Folder / Export Log File / Export to Default on web', async () => {
    renderWeb()

    await screen.findByRole('button', { name: /Copy Log Contents/ })
    expect(screen.queryByRole('button', { name: /Reveal Log Folder/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Export Log File\.\.\./ })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Export to Default Directory/ })
    ).not.toBeInTheDocument()
  })

  it('replaces the ACP timeout selects with a read-only managed note on web', async () => {
    renderWeb()

    expect(
      await screen.findByText(/Managed by the server — timeouts for agents spawned/i)
    ).toBeInTheDocument()
    expect(screen.queryByLabelText(/Turn Timeout \(hard cap\)/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Turn Idle Timeout')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Session/New Timeout')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Session Reopen Timeout')).not.toBeInTheDocument()
  })

  it('hides the New Browser Tab shortcut row on web but keeps other shortcuts', async () => {
    renderWeb()

    await screen.findByText('Command Palette')
    expect(screen.queryByText('New Browser Tab')).not.toBeInTheDocument()
    expect(screen.getByText('Agent Launcher')).toBeInTheDocument()
  })

  it('keeps Copy Log Contents enabled on web (works in the browser)', async () => {
    renderWeb()

    const copy = await screen.findByRole('button', { name: /Copy Log Contents/ })
    expect(copy).toBeEnabled()
  })

  it('offers the update controls ungated on desktop', async () => {
    renderPage()

    const check = await screen.findByRole('button', { name: /Check for Updates/ })
    expect(check).toBeEnabled()
    expect(check).not.toHaveAttribute('title')

    const reveal = screen.getByRole('button', { name: /Reveal Log Folder/ })
    expect(reveal).toBeEnabled()
    expect(reveal).not.toHaveAttribute('title')
  })
})
