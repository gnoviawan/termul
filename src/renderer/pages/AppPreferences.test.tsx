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

// Story 8 (web honesty): desktop-only Preferences entries must render
// gated with an explicit desktop-only status on web — never a silent
// no-op button. Copy Log Contents stays available (works on web).
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

  it('disables Check for Updates with a desktop-only reason on web', async () => {
    renderWeb()

    const button = await screen.findByRole('button', { name: /Check for Updates/ })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Update checks are desktop-only')
    expect(
      screen.getByText('Desktop only — the web client is updated together with the server.')
    ).toBeInTheDocument()
  })

  it('disables the Auto-update toggle with a desktop-only reason on web', async () => {
    renderWeb()

    await screen.findByText('Automatically check for updates')
    // The toggle button has no accessible name; locate it as the row-level
    // button next to the label text (the flex row that contains both).
    const label = screen.getByText('Automatically check for updates')
    const row = label.parentElement!.parentElement!
    const toggle = row.querySelector('button')!
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('title', 'Auto-update is desktop-only')
    expect(
      screen.getByText('Desktop only — automatic update checks run in the desktop app.')
    ).toBeInTheDocument()
  })

  it('disables Reveal Log Folder / Export Log File / Export to Default with desktop-only reasons on web', async () => {
    renderWeb()

    const reveal = await screen.findByRole('button', { name: /Reveal Log Folder/ })
    expect(reveal).toBeDisabled()
    expect(reveal).toHaveAttribute('title', 'Revealing the log folder is desktop-only')
    expect(screen.getByText('Desktop only — the log folder lives on the host.')).toBeInTheDocument()

    const exportFile = screen.getByRole('button', { name: /Export Log File\.\.\./ })
    expect(exportFile).toBeDisabled()
    expect(exportFile).toHaveAttribute('title', 'Exporting the log file is desktop-only')
    expect(
      screen.getByText('Desktop only — file dialogs are unavailable in the browser.')
    ).toBeInTheDocument()

    const exportDefault = screen.getByRole('button', { name: /Export to Default Directory/ })
    expect(exportDefault).toBeDisabled()
    expect(exportDefault).toHaveAttribute('title', 'Exporting to Downloads is desktop-only')
  })

  it('labels every ACP timeout select description as desktop-only (explicit, not editable-broken)', async () => {
    // jsdom + no __TAURI_INTERNALS__: web mode. The four ACP timeout
    // selects must carry an explicit "Desktop only" reason in their
    // descriptions so the disabled state is self-explaining.
    renderWeb()

    const labels = [
      'Maximum wall-clock duration for a single agent turn.',
      'Window with no agent activity after which a turn is treated as wedged and cancelled.',
      'How long to wait for an agent to answer session/new before the spawn fails',
      'How long to wait for session/load / session/resume'
    ]
    for (const label of labels) {
      const el = await screen.findByText(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      const paragraph = el.closest('p')
      expect(paragraph?.textContent).toContain('Desktop only')
    }
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
