import { act, fireEvent, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore } from '@/stores/canvas-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { DEFAULT_KEYBOARD_SHORTCUTS } from '@/types/settings'
import { useWorkspaceKeyboard } from './use-workspace-keyboard'

const { mockWriteDebounced, mockWrite, mockToastError, mockLog } = vi.hoisted(() => ({
  mockWriteDebounced: vi.fn(),
  mockWrite: vi.fn(),
  mockToastError: vi.fn(),
  mockLog: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  keyboardApi: { onShortcut: vi.fn(() => () => undefined) },
  persistenceApi: {
    read: vi.fn(),
    write: mockWrite,
    delete: vi.fn(),
    writeDebounced: mockWriteDebounced
  },
  acpApi: {},
  terminalApi: {}
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLog }))
vi.mock('sonner', () => ({ toast: { error: mockToastError } }))
vi.mock('@/lib/platform', () => ({ isMac: false }))

const CUSTOM_SIDEBAR_KEY = 'ctrl+alt+j'
const CUSTOM_EXPLORER_KEY = 'ctrl+alt+k'

function mountKeyboard(
  overrides: Record<string, string> = {},
  activeTab: Parameters<typeof useWorkspaceKeyboard>[0]['activeTab'] = undefined
) {
  const getActiveKey = (id: string): string =>
    overrides[id] ??
    DEFAULT_KEYBOARD_SHORTCUTS[id as keyof typeof DEFAULT_KEYBOARD_SHORTCUTS]?.defaultKey ??
    ''
  return renderHook(() =>
    useWorkspaceKeyboard({
      activeTab,
      activeProjectId: '',
      projects: [],
      selectProject: vi.fn(),
      isWorkspaceRoute: true,
      isAgentLauncherOpen: false,
      closeActiveTab: vi.fn(),
      getActiveKey,
      handleNewBrowserTab: vi.fn(),
      handleOpenThemePicker: vi.fn(),
      setIsCommandPaletteOpen: vi.fn(),
      setIsCommandHistoryOpen: vi.fn(),
      setIsNewProjectModalOpen: vi.fn()
    })
  )
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  act(() => {
    fireEvent.keyDown(target, { key, ...init })
  })
}

const layout = () => useShellLayoutStore.getState()

describe('useWorkspaceKeyboard panel toggles (shell-layout store)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWriteDebounced.mockResolvedValue({ success: true, data: undefined })
    mockWrite.mockResolvedValue({ success: true, data: undefined })
    resetShellLayoutStoreForTests()
    // Start with the right panel open so each toggle has something to close.
    useShellLayoutStore.setState({ status: 'ready', sidePanelVisible: true })
  })

  it('keeps the shortcut ids, with Ctrl+B on the Rail and Ctrl+Alt+B on the Side panel', () => {
    expect(DEFAULT_KEYBOARD_SHORTCUTS.sidebarToggle).toMatchObject({
      id: 'sidebarToggle',
      label: 'Toggle Projects',
      description: 'Expand or collapse the projects sidebar',
      defaultKey: 'ctrl+b'
    })
    expect(DEFAULT_KEYBOARD_SHORTCUTS.toggleFileExplorer).toMatchObject({
      id: 'toggleFileExplorer',
      label: 'Toggle Side Panel',
      description: 'Show or hide the side panel at the right edge',
      defaultKey: 'ctrl+alt+b'
    })
  })

  it('default Ctrl+B flips railExpanded and Ctrl+Alt+B flips sidePanelVisible', () => {
    mountKeyboard()

    press('b', { ctrlKey: true, code: 'KeyB' })
    expect(layout().railExpanded).toBe(false)
    expect(layout().sidePanelVisible).toBe(true)

    press('b', { ctrlKey: true, altKey: true, code: 'KeyB' })
    expect(layout().sidePanelVisible).toBe(false)
    expect(layout().railExpanded).toBe(false)

    press('b', { ctrlKey: true, code: 'KeyB' })
    expect(layout().railExpanded).toBe(true)
  })

  it('matches Ctrl+Alt+B by its physical key when Option changes the character (macOS ⌘⌥B)', () => {
    mountKeyboard()

    press('∫', { ctrlKey: true, altKey: true, code: 'KeyB' })
    expect(layout().sidePanelVisible).toBe(false)
    expect(layout().railExpanded).toBe(true)
  })

  it('logs the Rail toggle from the shortcut', () => {
    mountKeyboard()

    press('b', { ctrlKey: true, code: 'KeyB' })

    expect(mockLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'info',
        source: 'Rail',
        message: '[rail] collapse rail (shortcut)'
      })
    )
  })

  it('persists through the shell-layout record and never through settings/app', () => {
    mountKeyboard()

    press('b', { ctrlKey: true })

    expect(mockWriteDebounced).toHaveBeenCalledWith(
      'shell-layout',
      expect.objectContaining({ railExpanded: false })
    )
    expect(mockWriteDebounced).not.toHaveBeenCalledWith('settings/app', expect.anything())
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('a custom sidebarToggle key flips railExpanded and the default key no longer does', () => {
    mountKeyboard({ sidebarToggle: CUSTOM_SIDEBAR_KEY })

    press('b', { ctrlKey: true })
    expect(layout().railExpanded).toBe(true)

    press('j', { ctrlKey: true, altKey: true })
    expect(layout().railExpanded).toBe(false)
  })

  it('a custom toggleFileExplorer key flips sidePanelVisible and the default key no longer does', () => {
    mountKeyboard({ toggleFileExplorer: CUSTOM_EXPLORER_KEY })

    press('b', { ctrlKey: true, altKey: true })
    expect(layout().sidePanelVisible).toBe(true)

    press('k', { ctrlKey: true, altKey: true })
    expect(layout().sidePanelVisible).toBe(false)
  })

  it('toggles the Rail from a terminal, where the Side panel toggle stays inert', () => {
    mountKeyboard()
    const terminal = document.createElement('div')
    terminal.className = 'xterm'
    const textarea = document.createElement('textarea')
    terminal.appendChild(textarea)
    document.body.appendChild(terminal)

    press('b', { ctrlKey: true, altKey: true, code: 'KeyB' }, textarea)
    expect(layout().sidePanelVisible).toBe(true)
    press('b', { ctrlKey: true, code: 'KeyB' }, textarea)
    expect(layout().railExpanded).toBe(false)
    document.body.removeChild(terminal)
  })

  it('skips both toggles in an input', () => {
    mountKeyboard()
    const input = document.createElement('input')
    document.body.appendChild(input)

    press('b', { ctrlKey: true }, input)
    press('b', { ctrlKey: true, altKey: true }, input)

    expect(layout().sidePanelVisible).toBe(true)
    expect(layout().railExpanded).toBe(true)
    document.body.removeChild(input)
  })

  it('ignores toggles before the shell layout is hydrated, without a toast', () => {
    resetShellLayoutStoreForTests()
    mountKeyboard()

    press('b', { ctrlKey: true })

    expect(layout().railExpanded).toBe(true)
    expect(mockWriteDebounced).not.toHaveBeenCalled()
    expect(mockToastError).not.toHaveBeenCalled()
  })
})

describe('useWorkspaceKeyboard save shortcut on a canvas tab', () => {
  it('Ctrl+S saves the active canvas and does not touch the editor', () => {
    const saveCanvas = vi.fn().mockResolvedValue(true)
    useCanvasStore.setState({ saveCanvas })
    mountKeyboard(
      {},
      { type: 'canvas', id: 'canvas-proj-1', projectId: 'proj-1', docPath: 'C:/p/design.figcraft' }
    )

    press('s', { ctrlKey: true })

    expect(saveCanvas).toHaveBeenCalledWith('proj-1')
  })
})
