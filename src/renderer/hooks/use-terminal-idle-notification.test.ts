import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendDesktopNotification } from '@/lib/tauri-notification-api'
import {
  TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS,
  TERMINAL_IDLE_NOTIFY_QUIET_MS
} from '@/lib/terminal-idle-notify'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import { useTerminalIdleNotification } from './use-terminal-idle-notification'

const { mockOnData, mockOnExit } = vi.hoisted(() => ({
  mockOnData: vi.fn(),
  mockOnExit: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  terminalApi: {
    onData: mockOnData,
    onExit: mockOnExit
  }
}))

vi.mock('@/lib/tauri-notification-api', () => ({
  sendDesktopNotification: vi.fn()
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => false
}))

type DataCallback = (ptyId: string, data: Uint8Array) => void
type ExitCallback = (ptyId: string, exitCode: number) => void

function renderIdleHook(): {
  emitData: DataCallback
  emitExit: ExitCallback
  unmount: () => void
} {
  let onData: DataCallback | undefined
  let onExit: ExitCallback | undefined
  const unsubData = vi.fn()
  const unsubExit = vi.fn()
  mockOnData.mockImplementation((cb: DataCallback) => {
    onData = cb
    return unsubData
  })
  mockOnExit.mockImplementation((cb: ExitCallback) => {
    onExit = cb
    return unsubExit
  })

  const { unmount } = renderHook(() => useTerminalIdleNotification())
  if (!onData || !onExit) {
    throw new Error('useTerminalIdleNotification did not subscribe to PTY events')
  }
  return {
    emitData: onData,
    emitExit: onExit,
    unmount: () => {
      unmount()
      expect(unsubData).toHaveBeenCalled()
      expect(unsubExit).toHaveBeenCalled()
    }
  }
}

const CHUNK = new Uint8Array([0x61])

function emitLongBusy(emitData: DataCallback, ptyId = 'pty-1'): void {
  const start = Date.now()
  emitData(ptyId, CHUNK)
  while (Date.now() - start < TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS) {
    vi.advanceTimersByTime(4_000)
    emitData(ptyId, CHUNK)
  }
}

describe('useTerminalIdleNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

    useAppSettingsStore.setState({
      settings: { ...DEFAULT_APP_SETTINGS, notifyOnTerminalIdle: true },
      isLoaded: true
    })
    useProjectStore.setState({
      projects: [{ id: 'proj-1', name: 'My Project', color: 'blue' }],
      activeProjectId: 'proj-1'
    })
    useTerminalStore.setState({
      terminals: [
        {
          id: 'term-1',
          name: 'claude',
          projectId: 'proj-1',
          shell: 'zsh',
          isAppHidden: true
        }
      ],
      activeTerminalId: 'term-1',
      ptyIdIndex: new Map([['pty-1', 'term-1']])
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    useAppSettingsStore.setState({ settings: { ...DEFAULT_APP_SETTINGS }, isLoaded: false })
    useProjectStore.setState({ projects: [], activeProjectId: '' })
    useTerminalStore.setState({ terminals: [], activeTerminalId: '', ptyIdIndex: new Map() })
  })

  it('sends a notification after a long busy stretch then quiet, while not viewing', () => {
    const { emitData } = renderIdleHook()
    emitLongBusy(emitData)
    vi.advanceTimersByTime(TERMINAL_IDLE_NOTIFY_QUIET_MS)

    expect(sendDesktopNotification).toHaveBeenCalledWith(
      'My Project',
      'claude — agent finished',
      expect.objectContaining({ onClick: expect.any(Function) })
    )
    const term = useTerminalStore.getState().terminals.find((t) => t.id === 'term-1')
    expect(term?.needsAttention).toBe(true)
  })

  it('does not notify a short command', () => {
    const { emitData } = renderIdleHook()
    emitData('pty-1', CHUNK)
    vi.advanceTimersByTime(TERMINAL_IDLE_NOTIFY_QUIET_MS)
    expect(sendDesktopNotification).not.toHaveBeenCalled()
  })

  it('does not notify when the setting is disabled', () => {
    useAppSettingsStore.setState({
      settings: { ...DEFAULT_APP_SETTINGS, notifyOnTerminalIdle: false },
      isLoaded: true
    })
    const { emitData } = renderIdleHook()
    emitLongBusy(emitData)
    vi.advanceTimersByTime(TERMINAL_IDLE_NOTIFY_QUIET_MS)
    expect(sendDesktopNotification).not.toHaveBeenCalled()
  })

  it('does not notify when the user is already watching that tab', () => {
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    useTerminalStore.setState({
      terminals: [
        {
          id: 'term-1',
          name: 'claude',
          projectId: 'proj-1',
          shell: 'zsh',
          isAppHidden: false
        }
      ],
      activeTerminalId: 'term-1',
      ptyIdIndex: new Map([['pty-1', 'term-1']])
    })
    const { emitData } = renderIdleHook()
    emitLongBusy(emitData)
    vi.advanceTimersByTime(TERMINAL_IDLE_NOTIFY_QUIET_MS)
    expect(sendDesktopNotification).not.toHaveBeenCalled()
    hasFocusSpy.mockRestore()
  })

  it('notification click selects the project and terminal', () => {
    useProjectStore.setState({
      projects: [
        { id: 'proj-1', name: 'My Project', color: 'blue' },
        { id: 'proj-2', name: 'Other', color: 'red' }
      ],
      activeProjectId: 'proj-2'
    })
    useTerminalStore.setState({
      terminals: [
        {
          id: 'term-1',
          name: 'claude',
          projectId: 'proj-1',
          shell: 'zsh',
          isAppHidden: true
        },
        {
          id: 'term-2',
          name: 'shell',
          projectId: 'proj-2',
          shell: 'zsh',
          isAppHidden: true
        }
      ],
      activeTerminalId: 'term-2',
      ptyIdIndex: new Map([
        ['pty-1', 'term-1'],
        ['pty-2', 'term-2']
      ])
    })

    const { emitData } = renderIdleHook()
    emitLongBusy(emitData)
    vi.advanceTimersByTime(TERMINAL_IDLE_NOTIFY_QUIET_MS)

    const onClick = vi.mocked(sendDesktopNotification).mock.calls[0]?.[2]?.onClick
    expect(onClick).toBeTypeOf('function')
    onClick?.()

    expect(useProjectStore.getState().activeProjectId).toBe('proj-1')
    expect(useTerminalStore.getState().activeTerminalId).toBe('term-1')
    expect(
      useTerminalStore.getState().terminals.find((t) => t.id === 'term-1')?.needsAttention
    ).toBe(false)
  })

  it('clears idle tracking when the PTY exits', () => {
    const { emitData, emitExit } = renderIdleHook()
    emitData('pty-1', CHUNK)
    emitExit('pty-1', 0)
    vi.advanceTimersByTime(TERMINAL_IDLE_NOTIFY_MIN_BUSY_MS + TERMINAL_IDLE_NOTIFY_QUIET_MS)
    expect(sendDesktopNotification).not.toHaveBeenCalled()
  })
})
