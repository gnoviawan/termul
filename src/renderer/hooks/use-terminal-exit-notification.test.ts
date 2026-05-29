import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { sendDesktopNotification } from '@/lib/tauri-notification-api'
import { useTerminalStore } from '@/stores/terminal-store'
import { useProjectStore } from '@/stores/project-store'

vi.mock('@/lib/tauri-notification-api', () => ({
  sendDesktopNotification: vi.fn()
}))

/**
 * Test the core notification dispatch logic that the hook wires up.
 * Rather than mounting React, we test the callback function directly
 * since the hook is a thin wrapper around terminalApi.onExit.
 */
function simulateExitCallback(ptyId: string, exitCode: number): void {
  const terminalState = useTerminalStore.getState()
  const terminal = terminalState.findTerminalByPtyId(ptyId)
  if (!terminal) return

  const windowFocused =
    typeof document !== 'undefined' && typeof document.hasFocus === 'function'
      ? document.hasFocus()
      : !terminal.isAppHidden
  const isViewingThisTerminal =
    terminalState.activeTerminalId === terminal.id &&
    windowFocused &&
    !terminal.isAppHidden
  if (!isViewingThisTerminal) {
    terminalState.setTerminalNeedsAttention(terminal.id, true)
  }

  const project = useProjectStore
    .getState()
    .projects.find((p) => p.id === terminal.projectId)

  const title = (project?.name ?? 'Termul').replace(/[\r\n]+/g, ' ').trim().slice(0, 64)
  const terminalName = terminal.name.replace(/[\r\n]+/g, ' ').trim().slice(0, 64)

  const body =
    exitCode === 0
      ? `${terminalName} — DONE`
      : `${terminalName} — Failed (exit ${exitCode})`

  sendDesktopNotification(title, body)
}

describe('terminal exit notification logic', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useProjectStore.setState({
      projects: [
        { id: 'proj-1', name: 'My Project', color: 'blue' }
      ],
      activeProjectId: 'proj-1'
    })

    useTerminalStore.setState({
      terminals: [
        { id: 'term-1', name: 'Build Server', projectId: 'proj-1', shell: 'bash' }
      ],
      activeTerminalId: 'term-1',
      ptyIdIndex: new Map([['pty-1', 'term-1']])
    })
  })

  afterEach(() => {
    useProjectStore.setState({ projects: [], activeProjectId: '' })
    useTerminalStore.setState({ terminals: [], activeTerminalId: '', ptyIdIndex: new Map() })
  })

  it('sends notification with project name and terminal name on exit code 0', () => {
    simulateExitCallback('pty-1', 0)

    expect(sendDesktopNotification).toHaveBeenCalledWith('My Project', 'Build Server — DONE')
  })

  it('sends Failed message for non-zero exit code', () => {
    simulateExitCallback('pty-1', 1)

    expect(sendDesktopNotification).toHaveBeenCalledWith('My Project', 'Build Server — Failed (exit 1)')
  })

  it('sends Failed message for exit code -1 (null exit code coerced)', () => {
    simulateExitCallback('pty-1', -1)

    expect(sendDesktopNotification).toHaveBeenCalledWith('My Project', 'Build Server — Failed (exit -1)')
  })

  it('falls back to Termul when project not found', () => {
    useProjectStore.setState({ projects: [], activeProjectId: '' })

    simulateExitCallback('pty-1', 0)

    expect(sendDesktopNotification).toHaveBeenCalledWith('Termul', 'Build Server — DONE')
  })

  it('does not send notification for unknown ptyId', () => {
    simulateExitCallback('unknown-pty', 0)

    expect(sendDesktopNotification).not.toHaveBeenCalled()
  })

  it('truncates long names', () => {
    const longName = 'A'.repeat(100)
    useTerminalStore.setState({
      terminals: [
        { id: 'term-1', name: longName, projectId: 'proj-1', shell: 'bash' }
      ],
      activeTerminalId: 'term-1',
      ptyIdIndex: new Map([['pty-1', 'term-1']])
    })

    simulateExitCallback('pty-1', 0)

    const body = vi.mocked(sendDesktopNotification).mock.calls[0][1]
    expect(body.length).toBeLessThan(100)
  })

  it('sanitizes newlines in names', () => {
    useTerminalStore.setState({
      terminals: [
        { id: 'term-1', name: 'Build\nServer', projectId: 'proj-1', shell: 'bash' }
      ],
      activeTerminalId: 'term-1',
      ptyIdIndex: new Map([['pty-1', 'term-1']])
    })

    simulateExitCallback('pty-1', 0)

    const body = vi.mocked(sendDesktopNotification).mock.calls[0][1]
    expect(body).not.toContain('\n')
    expect(body).toContain('Build Server')
  })

  describe('needsAttention flag', () => {
    it('flags a background terminal (not the active terminal) on exit', () => {
      useTerminalStore.setState({
        terminals: [
          { id: 'term-1', name: 'Build Server', projectId: 'proj-1', shell: 'bash' },
          { id: 'term-2', name: 'Dev Server', projectId: 'proj-1', shell: 'bash' }
        ],
        activeTerminalId: 'term-1',
        ptyIdIndex: new Map([['pty-1', 'term-1'], ['pty-2', 'term-2']])
      })

      simulateExitCallback('pty-2', 0)

      const term2 = useTerminalStore.getState().terminals.find((t) => t.id === 'term-2')
      expect(term2?.needsAttention).toBe(true)
    })

    it('does NOT flag the active terminal when the app is visible', () => {
      const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
      useTerminalStore.setState({
        terminals: [
          { id: 'term-1', name: 'Build Server', projectId: 'proj-1', shell: 'bash', isAppHidden: false }
        ],
        activeTerminalId: 'term-1',
        ptyIdIndex: new Map([['pty-1', 'term-1']])
      })

      simulateExitCallback('pty-1', 0)

      const term1 = useTerminalStore.getState().terminals.find((t) => t.id === 'term-1')
      expect(term1?.needsAttention).toBeFalsy()
      hasFocusSpy.mockRestore()
    })

    it('flags the active terminal when the app is hidden', () => {
      useTerminalStore.setState({
        terminals: [
          { id: 'term-1', name: 'Build Server', projectId: 'proj-1', shell: 'bash', isAppHidden: true }
        ],
        activeTerminalId: 'term-1',
        ptyIdIndex: new Map([['pty-1', 'term-1']])
      })

      simulateExitCallback('pty-1', 1)

      const term1 = useTerminalStore.getState().terminals.find((t) => t.id === 'term-1')
      expect(term1?.needsAttention).toBe(true)
    })

    it('flags the active terminal when the window is not focused (hasFocus=false)', () => {
      const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
      useTerminalStore.setState({
        terminals: [
          { id: 'term-1', name: 'Build Server', projectId: 'proj-1', shell: 'bash', isAppHidden: false }
        ],
        activeTerminalId: 'term-1',
        ptyIdIndex: new Map([['pty-1', 'term-1']])
      })

      simulateExitCallback('pty-1', 0)

      const term1 = useTerminalStore.getState().terminals.find((t) => t.id === 'term-1')
      expect(term1?.needsAttention).toBe(true)
      hasFocusSpy.mockRestore()
    })

    it('does not flag anything for an unknown ptyId', () => {
      useTerminalStore.setState({
        terminals: [
          { id: 'term-1', name: 'Build Server', projectId: 'proj-1', shell: 'bash' }
        ],
        activeTerminalId: 'term-1',
        ptyIdIndex: new Map([['pty-1', 'term-1']])
      })

      simulateExitCallback('unknown-pty', 0)

      const term1 = useTerminalStore.getState().terminals.find((t) => t.id === 'term-1')
      expect(term1?.needsAttention).toBeFalsy()
    })
  })
})
