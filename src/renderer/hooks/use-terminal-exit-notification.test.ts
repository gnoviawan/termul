import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockOnExit } = vi.hoisted(() => ({
  mockOnExit: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  terminalApi: {
    onExit: mockOnExit
  }
}))

vi.mock('@/lib/tauri-notification-api', () => ({
  sendDesktopNotification: vi.fn()
}))

import { sendDesktopNotification } from '@/lib/tauri-notification-api'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useTerminalExitNotification } from './use-terminal-exit-notification'

/** Matches MAX_NOTIFICATION_TEXT_LENGTH in use-terminal-exit-notification.ts */
const MAX_NOTIFICATION_TEXT_LENGTH = 64

type ExitCallback = (ptyId: string, exitCode: number) => void

/**
 * Render the real hook so its `terminalApi.onExit` subscription/effect lifecycle is
 * exercised, and return the actual exit callback the hook registered. Emitting through
 * this callback drives the production code path (flag + notification side-effects)
 * rather than re-implementing it.
 */
function renderExitHook(): { emitExit: ExitCallback; unmount: () => void } {
  const unsubscribe = vi.fn()
  let captured: ExitCallback | undefined
  mockOnExit.mockImplementation((cb: ExitCallback) => {
    captured = cb
    return unsubscribe
  })

  const { unmount } = renderHook(() => useTerminalExitNotification())

  if (!captured) {
    throw new Error('useTerminalExitNotification did not register an onExit callback')
  }

  return {
    emitExit: captured,
    unmount: () => {
      unmount()
      expect(unsubscribe).toHaveBeenCalled()
    }
  }
}

describe('terminal exit notification logic', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useProjectStore.setState({
      projects: [{ id: 'proj-1', name: 'My Project', color: 'blue' }],
      activeProjectId: 'proj-1'
    })

    useTerminalStore.setState({
      terminals: [{ id: 'term-1', name: 'Build Server', projectId: 'proj-1', shell: 'bash' }],
      activeTerminalId: 'term-1',
      ptyIdIndex: new Map([['pty-1', 'term-1']])
    })
  })

  afterEach(() => {
    useProjectStore.setState({ projects: [], activeProjectId: '' })
    useTerminalStore.setState({ terminals: [], activeTerminalId: '', ptyIdIndex: new Map() })
  })

  it('registers an onExit subscription when mounted and unsubscribes on unmount', () => {
    const { unmount } = renderExitHook()
    expect(mockOnExit).toHaveBeenCalledTimes(1)
    unmount()
  })

  it('sends notification with project name and terminal name on exit code 0', () => {
    const { emitExit } = renderExitHook()
    emitExit('pty-1', 0)

    expect(sendDesktopNotification).toHaveBeenCalledWith('My Project', 'Build Server — DONE')
  })

  it('sends Failed message for non-zero exit code', () => {
    const { emitExit } = renderExitHook()
    emitExit('pty-1', 1)

    expect(sendDesktopNotification).toHaveBeenCalledWith(
      'My Project',
      'Build Server — Failed (exit 1)'
    )
  })

  it('sends Failed message for exit code -1 (null exit code coerced)', () => {
    const { emitExit } = renderExitHook()
    emitExit('pty-1', -1)

    expect(sendDesktopNotification).toHaveBeenCalledWith(
      'My Project',
      'Build Server — Failed (exit -1)'
    )
  })

  it('falls back to Termul when project not found', () => {
    useProjectStore.setState({ projects: [], activeProjectId: '' })

    const { emitExit } = renderExitHook()
    emitExit('pty-1', 0)

    expect(sendDesktopNotification).toHaveBeenCalledWith('Termul', 'Build Server — DONE')
  })

  it('does not send notification for unknown ptyId', () => {
    const { emitExit } = renderExitHook()
    emitExit('unknown-pty', 0)

    expect(sendDesktopNotification).not.toHaveBeenCalled()
  })

  it('truncates long names to exactly MAX length with an ellipsis as the final char', () => {
    const longName = 'A'.repeat(100)
    useTerminalStore.setState({
      terminals: [{ id: 'term-1', name: longName, projectId: 'proj-1', shell: 'bash' }],
      activeTerminalId: 'term-1',
      ptyIdIndex: new Map([['pty-1', 'term-1']])
    })

    const { emitExit } = renderExitHook()
    emitExit('pty-1', 0)

    // Production contract (sanitizeNotificationText): slice(0, MAX-1) + '…'.
    // The truncated terminal name is then interpolated into the body.
    const truncatedName = `${'A'.repeat(MAX_NOTIFICATION_TEXT_LENGTH - 1)}…`
    expect(truncatedName).toHaveLength(MAX_NOTIFICATION_TEXT_LENGTH)
    expect(sendDesktopNotification).toHaveBeenCalledWith('My Project', `${truncatedName} — DONE`)
  })

  it('sanitizes newlines in names', () => {
    useTerminalStore.setState({
      terminals: [{ id: 'term-1', name: 'Build\nServer', projectId: 'proj-1', shell: 'bash' }],
      activeTerminalId: 'term-1',
      ptyIdIndex: new Map([['pty-1', 'term-1']])
    })

    const { emitExit } = renderExitHook()
    emitExit('pty-1', 0)

    expect(sendDesktopNotification).toHaveBeenCalledWith('My Project', 'Build Server — DONE')
  })

  describe('needsAttention flag', () => {
    it('flags a background terminal (not the active terminal) on exit', () => {
      useTerminalStore.setState({
        terminals: [
          { id: 'term-1', name: 'Build Server', projectId: 'proj-1', shell: 'bash' },
          { id: 'term-2', name: 'Dev Server', projectId: 'proj-1', shell: 'bash' }
        ],
        activeTerminalId: 'term-1',
        ptyIdIndex: new Map([
          ['pty-1', 'term-1'],
          ['pty-2', 'term-2']
        ])
      })

      const { emitExit } = renderExitHook()
      emitExit('pty-2', 0)

      const term2 = useTerminalStore.getState().terminals.find((t) => t.id === 'term-2')
      expect(term2?.needsAttention).toBe(true)
    })

    it('does NOT flag the active terminal when the app is visible', () => {
      const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      useTerminalStore.setState({
        terminals: [
          {
            id: 'term-1',
            name: 'Build Server',
            projectId: 'proj-1',
            shell: 'bash',
            isAppHidden: false
          }
        ],
        activeTerminalId: 'term-1',
        ptyIdIndex: new Map([['pty-1', 'term-1']])
      })

      const { emitExit } = renderExitHook()
      emitExit('pty-1', 0)

      const term1 = useTerminalStore.getState().terminals.find((t) => t.id === 'term-1')
      expect(term1?.needsAttention).toBeFalsy()
      hasFocusSpy.mockRestore()
    })

    it('flags the active terminal when the app is hidden', () => {
      useTerminalStore.setState({
        terminals: [
          {
            id: 'term-1',
            name: 'Build Server',
            projectId: 'proj-1',
            shell: 'bash',
            isAppHidden: true
          }
        ],
        activeTerminalId: 'term-1',
        ptyIdIndex: new Map([['pty-1', 'term-1']])
      })

      const { emitExit } = renderExitHook()
      emitExit('pty-1', 1)

      const term1 = useTerminalStore.getState().terminals.find((t) => t.id === 'term-1')
      expect(term1?.needsAttention).toBe(true)
    })

    it('flags the active terminal when the window is not focused (hasFocus=false)', () => {
      const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
      useTerminalStore.setState({
        terminals: [
          {
            id: 'term-1',
            name: 'Build Server',
            projectId: 'proj-1',
            shell: 'bash',
            isAppHidden: false
          }
        ],
        activeTerminalId: 'term-1',
        ptyIdIndex: new Map([['pty-1', 'term-1']])
      })

      const { emitExit } = renderExitHook()
      emitExit('pty-1', 0)

      const term1 = useTerminalStore.getState().terminals.find((t) => t.id === 'term-1')
      expect(term1?.needsAttention).toBe(true)
      hasFocusSpy.mockRestore()
    })

    it('does not flag anything for an unknown ptyId', () => {
      useTerminalStore.setState({
        terminals: [{ id: 'term-1', name: 'Build Server', projectId: 'proj-1', shell: 'bash' }],
        activeTerminalId: 'term-1',
        ptyIdIndex: new Map([['pty-1', 'term-1']])
      })

      const { emitExit } = renderExitHook()
      emitExit('unknown-pty', 0)

      const term1 = useTerminalStore.getState().terminals.find((t) => t.id === 'term-1')
      expect(term1?.needsAttention).toBeFalsy()
    })
  })
})
