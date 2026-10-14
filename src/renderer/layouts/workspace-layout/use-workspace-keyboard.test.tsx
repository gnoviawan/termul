import { act, fireEvent, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { DEFAULT_KEYBOARD_SHORTCUTS } from '@/types/settings'
import { useWorkspaceKeyboard } from './use-workspace-keyboard'

const { mockWriteDebounced, mockWrite, mockToastError } = vi.hoisted(() => ({
  mockWriteDebounced: vi.fn(),
  mockWrite: vi.fn(),
  mockToastError: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  persistenceApi: {
    read: vi.fn(),
    write: mockWrite,
    delete: vi.fn(),
    writeDebounced: mockWriteDebounced
  },
  acpApi: {},
  terminalApi: {}
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mockToastError } }))
vi.mock('@/lib/platform', () => ({ isMac: false }))

const CUSTOM_SIDEBAR_KEY = 'ctrl+alt+j'
const CUSTOM_EXPLORER_KEY = 'ctrl+alt+k'

function mountKeyboard(overrides: Record<string, string> = {}) {
  const getActiveKey = (id: string): string =>
    overrides[id] ??
    DEFAULT_KEYBOARD_SHORTCUTS[id as keyof typeof DEFAULT_KEYBOARD_SHORTCUTS]?.defaultKey ??
    ''
  return renderHook(() =>
    useWorkspaceKeyboard({
      activeTab: undefined,
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
    useShellLayoutStore.setState({ status: 'ready' })
  })

  it('keeps the shortcut ids and default keys, with the new labels', () => {
    expect(DEFAULT_KEYBOARD_SHORTCUTS.sidebarToggle).toMatchObject({
      id: 'sidebarToggle',
      label: 'Toggle Projects',
      description: 'Expand or collapse projects',
      defaultKey: 'ctrl+shift+b'
    })
    expect(DEFAULT_KEYBOARD_SHORTCUTS.toggleFileExplorer).toMatchObject({
      id: 'toggleFileExplorer',
      label: 'Toggle Side Panel',
      description: 'Show or hide side panel',
      defaultKey: 'ctrl+b'
    })
  })

  it('default Ctrl+B flips sidePanelVisible and Ctrl+Shift+B flips railExpanded', () => {
    mountKeyboard()

    press('b', { ctrlKey: true })
    expect(layout().sidePanelVisible).toBe(false)
    expect(layout().railExpanded).toBe(true)

    press('B', { ctrlKey: true, shiftKey: true })
    expect(layout().railExpanded).toBe(false)

    press('b', { ctrlKey: true })
    expect(layout().sidePanelVisible).toBe(true)
  })

  it('persists through the shell-layout record and never through settings/app', () => {
    mountKeyboard()

    press('b', { ctrlKey: true })

    expect(mockWriteDebounced).toHaveBeenCalledWith(
      'shell-layout',
      expect.objectContaining({ sidePanelVisible: false })
    )
    expect(mockWriteDebounced).not.toHaveBeenCalledWith('settings/app', expect.anything())
    expect(mockWrite).not.toHaveBeenCalled()
  })

  it('a custom sidebarToggle key flips railExpanded and the default key no longer does', () => {
    mountKeyboard({ sidebarToggle: CUSTOM_SIDEBAR_KEY })

    press('B', { ctrlKey: true, shiftKey: true })
    expect(layout().railExpanded).toBe(true)

    press('j', { ctrlKey: true, altKey: true })
    expect(layout().railExpanded).toBe(false)
  })

  it('a custom toggleFileExplorer key flips sidePanelVisible and the default key no longer does', () => {
    mountKeyboard({ toggleFileExplorer: CUSTOM_EXPLORER_KEY })

    press('b', { ctrlKey: true })
    expect(layout().sidePanelVisible).toBe(true)

    press('k', { ctrlKey: true, altKey: true })
    expect(layout().sidePanelVisible).toBe(false)
  })

  it('skips the explorer toggle in an input and the sidebar toggle in an input', () => {
    mountKeyboard()
    const input = document.createElement('input')
    document.body.appendChild(input)

    press('b', { ctrlKey: true }, input)
    press('B', { ctrlKey: true, shiftKey: true }, input)

    expect(layout().sidePanelVisible).toBe(true)
    expect(layout().railExpanded).toBe(true)
    document.body.removeChild(input)
  })

  it('ignores toggles before the shell layout is hydrated, without a toast', () => {
    resetShellLayoutStoreForTests()
    mountKeyboard()

    press('b', { ctrlKey: true })

    expect(layout().sidePanelVisible).toBe(true)
    expect(mockWriteDebounced).not.toHaveBeenCalled()
    expect(mockToastError).not.toHaveBeenCalled()
  })
})
