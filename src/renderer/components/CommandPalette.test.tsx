import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@/types/project'
import { CommandPalette } from './CommandPalette'

window.HTMLElement.prototype.scrollIntoView = vi.fn()

const saveRecentCommand = vi.fn(() => Promise.resolve())
let recentCommandIds: string[] = []

const togglePinnedCommand = vi.fn(() => Promise.resolve())
let pinnedCommandIds: string[] = []

vi.mock('@/hooks/use-recent-commands', () => ({
  useRecentCommandIds: () => recentCommandIds,
  useSaveRecentCommand: () => saveRecentCommand
}))

vi.mock('@/hooks/use-pinned-commands', () => ({
  usePinnedCommandIds: () => pinnedCommandIds,
  useTogglePinnedCommand: () => togglePinnedCommand
}))

// Story 8 (web honesty): the New Browser Tab command is desktop-only — the
// palette must omit it on web. Mutable ref defaults to desktop so the
// existing palette tests (which assert the command's presence and execute
// behavior) keep running in desktop mode; the web-mode test flips it.
const { tauriRef, mobileRef } = vi.hoisted(() => ({
  tauriRef: { current: true as boolean },
  // Story 11: mutable so the mobile-ergonomics tests can flip the shell.
  mobileRef: { current: false as boolean }
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => tauriRef.current
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

const projects: Project[] = [
  {
    id: 'alpha',
    name: 'Alpha',
    color: 'blue',
    path: '/work/alpha'
  },
  {
    id: 'beta',
    name: 'Beta',
    color: 'green',
    path: '/work/beta'
  }
]

function renderPalette(overrides: Partial<React.ComponentProps<typeof CommandPalette>> = {}) {
  const props: React.ComponentProps<typeof CommandPalette> = {
    isOpen: true,
    onClose: vi.fn(),
    projects,
    onSwitchProject: vi.fn(),
    onAddTerminal: vi.fn(),
    onShowAgentLauncher: vi.fn(),
    onSaveSnapshot: vi.fn(),
    onNewBrowserTab: vi.fn(),
    onOpenProjectSettings: vi.fn(),
    onOpenAppPreferences: vi.fn(),
    onOpenCommandHistory: vi.fn(),
    onOpenShortcutMenu: vi.fn(),
    onOpenThemePicker: vi.fn(),
    getShortcutLabel: (id) => {
      const labels: Record<string, string> = {
        newTerminal: 'Ctrl+T',
        newBrowserTab: 'Ctrl+Shift+N',
        commandHistory: 'Ctrl+R',
        colorThemePicker: 'Ctrl+Alt+T'
      }
      return labels[id]
    },
    getProjectShortcutLabel: (index) => `Ctrl+${index + 1}`,
    ...overrides
  }

  return {
    ...render(<CommandPalette {...props} />),
    props
  }
}

describe('CommandPalette', () => {
  beforeEach(() => {
    recentCommandIds = []
    pinnedCommandIds = []
    saveRecentCommand.mockClear()
    togglePinnedCommand.mockClear()
    tauriRef.current = true
  })

  it('renders a compact command-center layout with metadata, categories, shortcuts, and footer hints', () => {
    renderPalette()

    expect(
      screen.getByPlaceholderText('Search commands, projects, settings...')
    ).toBeInTheDocument()
    expect(screen.getByText('Workspace')).toBeInTheDocument()
    expect(screen.getByText('Navigation')).toBeInTheDocument()
    expect(screen.getByText('Projects')).toBeInTheDocument()
    expect(screen.getByText('Tools')).toBeInTheDocument()
    expect(screen.getByText('Open a new shell in the active pane')).toBeInTheDocument()
    expect(
      screen.getByText('Show the agent launcher prompt in the active pane')
    ).toBeInTheDocument()
    expect(screen.getByText('Ctrl+T')).toBeInTheDocument()
    expect(screen.getByText('Navigate')).toBeInTheDocument()
    expect(screen.getByText('Select')).toBeInTheDocument()
    expect(screen.getByText('Close')).toBeInTheDocument()
  })

  it('orders the Projects group above Workspace, Navigation, and Tools', () => {
    const { container } = renderPalette()

    const headings = Array.from(container.querySelectorAll('[cmdk-group-heading]')).map(
      (el) => el.textContent
    )

    const projectsIndex = headings.indexOf('Projects')
    expect(projectsIndex).toBeGreaterThanOrEqual(0)
    expect(projectsIndex).toBeLessThan(headings.indexOf('Workspace'))
    expect(projectsIndex).toBeLessThan(headings.indexOf('Navigation'))
    expect(projectsIndex).toBeLessThan(headings.indexOf('Tools'))
  })

  it('uses resolved shortcut labels supplied by the shell', () => {
    renderPalette({
      getShortcutLabel: (id) => {
        const labels: Record<string, string> = {
          newTerminal: 'Alt+T',
          newBrowserTab: 'Alt+B',
          commandHistory: 'Alt+H',
          colorThemePicker: 'Alt+Shift+T'
        }
        return labels[id]
      },
      getProjectShortcutLabel: (index) => `Alt+${index + 1}`
    })

    expect(screen.getByText('Alt+T')).toBeInTheDocument()
    expect(screen.getByText('Alt+B')).toBeInTheDocument()
    expect(screen.getByText('Alt+H')).toBeInTheDocument()
    expect(screen.getByText('Alt+Shift+T')).toBeInTheDocument()
    expect(screen.getByText('Alt+1')).toBeInTheDocument()
    expect(screen.queryByText('Ctrl+T')).not.toBeInTheDocument()
    expect(screen.queryByText('Ctrl+Shift+N')).not.toBeInTheDocument()
    expect(screen.queryByText('Ctrl+R')).not.toBeInTheDocument()
  })

  it('searches settings, prefs, and history keywords', async () => {
    renderPalette()
    const input = screen.getByPlaceholderText('Search commands, projects, settings...')

    fireEvent.change(input, { target: { value: 'settings' } })
    await waitFor(() => {
      expect(screen.getByText('Project Settings')).toBeInTheDocument()
      expect(screen.getByText('App Preferences')).toBeInTheDocument()
    })

    fireEvent.change(input, { target: { value: 'prefs' } })
    await waitFor(() => {
      expect(screen.getByText('App Preferences')).toBeInTheDocument()
    })

    fireEvent.change(input, { target: { value: 'history' } })
    await waitFor(() => {
      expect(screen.getByText('Command History')).toBeInTheDocument()
      expect(screen.getByText('Review and reuse recent terminal commands')).toBeInTheDocument()
    })
  })

  it('switches projects, closes, and records recent command id', async () => {
    const { props } = renderPalette()

    fireEvent.click(screen.getByText('Beta'))

    await waitFor(() => {
      expect(saveRecentCommand).toHaveBeenCalledWith('project-beta')
      expect(props.onClose).toHaveBeenCalled()
      expect(props.onSwitchProject).toHaveBeenCalledWith('beta')
    })
  })

  it('renders project rows with a bare name and no "Switch to Project:" prefix', () => {
    renderPalette()

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.queryByText('Switch to Project: Alpha')).not.toBeInTheDocument()
    expect(screen.queryByText('Switch to Project: Beta')).not.toBeInTheDocument()
  })

  it('executes optional callbacks after closing and records selected command ids', async () => {
    const cases: Array<{
      label: string
      commandId: string
      callback: keyof React.ComponentProps<typeof CommandPalette>
    }> = [
      { label: 'New Terminal', commandId: 'new-terminal', callback: 'onAddTerminal' },
      {
        label: 'Agent Launcher',
        commandId: 'show-agent-launcher',
        callback: 'onShowAgentLauncher'
      },
      { label: 'New Browser Tab', commandId: 'new-browser-tab', callback: 'onNewBrowserTab' },
      { label: 'Save Workspace Snapshot', commandId: 'save-snapshot', callback: 'onSaveSnapshot' },
      {
        label: 'Project Settings',
        commandId: 'open-project-settings',
        callback: 'onOpenProjectSettings'
      },
      {
        label: 'App Preferences',
        commandId: 'open-app-preferences',
        callback: 'onOpenAppPreferences'
      },
      {
        label: 'Command History',
        commandId: 'open-command-history',
        callback: 'onOpenCommandHistory'
      },
      {
        label: 'Open Shortcut Menu',
        commandId: 'open-shortcut-menu',
        callback: 'onOpenShortcutMenu'
      },
      {
        label: 'Change Color Theme',
        commandId: 'change-color-theme',
        callback: 'onOpenThemePicker'
      }
    ]

    for (const testCase of cases) {
      saveRecentCommand.mockClear()
      const { props, unmount } = renderPalette()

      fireEvent.click(screen.getByText(testCase.label))

      await waitFor(() => {
        expect(saveRecentCommand).toHaveBeenCalledWith(testCase.commandId)
        expect(props.onClose).toHaveBeenCalled()
        expect(props[testCase.callback]).toHaveBeenCalled()
      })

      unmount()
    }
  })

  it('omits optional commands when callbacks are unavailable', () => {
    renderPalette({
      onAddTerminal: undefined,
      onShowAgentLauncher: undefined,
      onSaveSnapshot: undefined,
      onNewBrowserTab: undefined,
      onOpenProjectSettings: undefined,
      onOpenAppPreferences: undefined,
      onOpenCommandHistory: undefined,
      onOpenShortcutMenu: undefined,
      onOpenThemePicker: undefined
    })

    expect(screen.queryByText('New Terminal')).not.toBeInTheDocument()
    expect(screen.queryByText('Agent Launcher')).not.toBeInTheDocument()
    expect(screen.queryByText('New Browser Tab')).not.toBeInTheDocument()
    expect(screen.queryByText('Save Workspace Snapshot')).not.toBeInTheDocument()
    expect(screen.queryByText('Project Settings')).not.toBeInTheDocument()
    expect(screen.queryByText('App Preferences')).not.toBeInTheDocument()
    expect(screen.queryByText('Command History')).not.toBeInTheDocument()
    expect(screen.queryByText('Open Shortcut Menu')).not.toBeInTheDocument()
    expect(screen.queryByText('Change Color Theme')).not.toBeInTheDocument()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  // Story 8 (web honesty): New Browser Tab is desktop-only — on the web
  // client the command must be absent (not present-but-broken), while other
  // workspace commands stay offered. On desktop it is offered exactly as
  // before (covered by the executes-callbacks + shortcut-label tests above).
  it('omits New Browser Tab on web while keeping other workspace commands', () => {
    const prev = tauriRef.current
    tauriRef.current = false
    try {
      const { props } = renderPalette()

      expect(screen.queryByText('New Browser Tab')).not.toBeInTheDocument()
      expect(screen.queryByText('Ctrl+Shift+N')).not.toBeInTheDocument()
      expect(screen.getByText('New Terminal')).toBeInTheDocument()
      expect(screen.getByText('Save Workspace Snapshot')).toBeInTheDocument()
      expect(props.onNewBrowserTab).not.toHaveBeenCalled()
    } finally {
      tauriRef.current = prev
    }
  })

  it('keeps recent commands visible when the search is empty', () => {
    recentCommandIds = ['open-command-history', 'project-alpha']

    renderPalette()

    expect(screen.getByText('Recent')).toBeInTheDocument()
    expect(screen.getAllByText('Command History')).toHaveLength(2)
    expect(screen.getAllByText('Alpha')).toHaveLength(2)
  })

  it('renders a Pinned group with pinned commands when the search is empty', () => {
    pinnedCommandIds = ['new-terminal', 'project-beta']

    renderPalette()

    expect(screen.getByText('Pinned')).toBeInTheDocument()
    expect(screen.getAllByText('New Terminal')).toHaveLength(2)
    expect(screen.getAllByText('Beta')).toHaveLength(2)
  })

  it('ignores pinned ids that do not resolve to a current command', () => {
    pinnedCommandIds = ['does-not-exist']

    renderPalette()

    expect(screen.queryByText('Pinned')).not.toBeInTheDocument()
  })

  it('toggles a pin without executing the command or closing the palette', async () => {
    const { props } = renderPalette()

    const pinButton = screen.getByLabelText('Pin New Terminal')
    fireEvent.click(pinButton)

    await waitFor(() => {
      expect(togglePinnedCommand).toHaveBeenCalledWith('new-terminal')
    })
    expect(props.onClose).not.toHaveBeenCalled()
    expect(props.onAddTerminal).not.toHaveBeenCalled()
    expect(saveRecentCommand).not.toHaveBeenCalled()
  })

  it('labels the toggle as Unpin for an already-pinned command', () => {
    pinnedCommandIds = ['new-terminal']

    renderPalette()

    expect(screen.getAllByLabelText('Unpin New Terminal').length).toBeGreaterThan(0)
  })

  it('keeps optimistic pin state when persistence fails', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    togglePinnedCommand.mockRejectedValueOnce(new Error('storage unavailable'))
    const { props } = renderPalette()

    fireEvent.click(screen.getByLabelText('Pin Save Workspace Snapshot'))

    await waitFor(() => {
      expect(consoleWarn).toHaveBeenCalledWith('Failed to toggle pinned command', expect.any(Error))
    })
    expect(props.onClose).not.toHaveBeenCalled()
    expect(props.onSaveSnapshot).not.toHaveBeenCalled()

    consoleWarn.mockRestore()
  })

  it('runs a command when recent-command persistence fails', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    saveRecentCommand.mockRejectedValueOnce(new Error('storage unavailable'))
    const { props } = renderPalette()

    fireEvent.click(screen.getByText('Save Workspace Snapshot'))

    await waitFor(() => {
      expect(props.onClose).toHaveBeenCalled()
      expect(props.onSaveSnapshot).toHaveBeenCalled()
      expect(consoleWarn).toHaveBeenCalledWith('Failed to save recent command', expect.any(Error))
    })

    consoleWarn.mockRestore()
  })

  it('closes on Escape and backdrop click', () => {
    const { container, props } = renderPalette()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(1)

    const backdrop = container.querySelector('.fixed.inset-0')
    expect(backdrop).not.toBeNull()
    fireEvent.click(backdrop as Element)
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })

  // ── Story 11 (QA F9): mobile palette ergonomics ──────────────────────────

  describe('mobile web shell', () => {
    beforeEach(() => {
      mobileRef.current = true
    })

    afterEach(() => {
      mobileRef.current = false
    })

    it('anchors the palette in the lower third (thumb zone), not top-anchored', () => {
      const { container } = renderPalette()

      const backdrop = container.querySelector('.fixed.inset-0')
      expect(backdrop).not.toBeNull()
      // Bottom-anchored with safe-area padding replaces the desktop pt-[7vh].
      expect(backdrop?.className).toContain('justify-end')
      expect(backdrop?.className).toContain('pb-[max(2rem,env(safe-area-inset-bottom))]')
      expect(backdrop?.className).not.toContain('pt-[7vh]')
    })

    it('hides the desktop kbd hints (↑↓/↵/Esc) and shows a touch-sized visible close', () => {
      const { props } = renderPalette()

      // Dead keyboard affordances are gone on touch.
      expect(screen.queryByText('Navigate')).not.toBeInTheDocument()
      expect(screen.queryByText('Select')).not.toBeInTheDocument()
      // The visible close button meets the 44px floor (size-11).
      const closeBtn = screen.getByRole('button', { name: 'Close command palette' })
      expect(closeBtn.className).toContain('size-11')
      fireEvent.click(closeBtn)
      expect(props.onClose).toHaveBeenCalledTimes(1)
    })

    it('keeps the desktop layout byte-identical off the mobile shell', () => {
      mobileRef.current = false
      const { container } = renderPalette()

      const backdrop = container.querySelector('.fixed.inset-0')
      expect(backdrop?.className).toContain('pt-[7vh]')
      expect(backdrop?.className).not.toContain('justify-end')
      // Desktop keeps the kbd hints + has no mobile close button.
      expect(screen.getByText('Navigate')).toBeInTheDocument()
      expect(screen.getByText('Select')).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Close command palette' })
      ).not.toBeInTheDocument()
    })
  })
})
