import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CommandPalette } from './CommandPalette'
import type { Project } from '@/types/project'

window.HTMLElement.prototype.scrollIntoView = vi.fn()

const saveRecentCommand = vi.fn(() => Promise.resolve())
let recentCommandIds: string[] = []

vi.mock('@/hooks/use-recent-commands', () => ({
  useRecentCommandIds: () => recentCommandIds,
  useSaveRecentCommand: () => saveRecentCommand
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
    onSaveSnapshot: vi.fn(),
    onNewBrowserTab: vi.fn(),
    onOpenProjectSettings: vi.fn(),
    onOpenAppPreferences: vi.fn(),
    onOpenCommandHistory: vi.fn(),
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
    saveRecentCommand.mockClear()
  })

  it('renders a compact command-center layout with metadata, categories, shortcuts, and footer hints', () => {
    renderPalette()

    expect(screen.getByPlaceholderText('Search commands, projects, settings...')).toBeInTheDocument()
    expect(screen.getByText('Workspace')).toBeInTheDocument()
    expect(screen.getByText('Navigation')).toBeInTheDocument()
    expect(screen.getByText('Projects')).toBeInTheDocument()
    expect(screen.getByText('Tools')).toBeInTheDocument()
    expect(screen.getByText('Open a terminal in the active pane')).toBeInTheDocument()
    expect(screen.getByText('Ctrl+T')).toBeInTheDocument()
    expect(screen.getByText('Recent commands saved')).toBeInTheDocument()
    expect(screen.getByText('Navigate')).toBeInTheDocument()
    expect(screen.getByText('Select')).toBeInTheDocument()
    expect(screen.getByText('Close')).toBeInTheDocument()
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

    fireEvent.click(screen.getByText('Switch to Project: Beta'))

    await waitFor(() => {
      expect(saveRecentCommand).toHaveBeenCalledWith('project-beta')
      expect(props.onClose).toHaveBeenCalled()
      expect(props.onSwitchProject).toHaveBeenCalledWith('beta')
    })
  })

  it('executes optional callbacks after closing and records selected command ids', async () => {
    const cases: Array<{
      label: string
      commandId: string
      callback: keyof React.ComponentProps<typeof CommandPalette>
    }> = [
      { label: 'New Terminal', commandId: 'new-terminal', callback: 'onAddTerminal' },
      { label: 'New Browser Tab', commandId: 'new-browser-tab', callback: 'onNewBrowserTab' },
      { label: 'Save Workspace Snapshot', commandId: 'save-snapshot', callback: 'onSaveSnapshot' },
      { label: 'Project Settings', commandId: 'open-project-settings', callback: 'onOpenProjectSettings' },
      { label: 'App Preferences', commandId: 'open-app-preferences', callback: 'onOpenAppPreferences' },
      { label: 'Command History', commandId: 'open-command-history', callback: 'onOpenCommandHistory' }
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
      onSaveSnapshot: undefined,
      onNewBrowserTab: undefined,
      onOpenProjectSettings: undefined,
      onOpenAppPreferences: undefined,
      onOpenCommandHistory: undefined
    })

    expect(screen.queryByText('New Terminal')).not.toBeInTheDocument()
    expect(screen.queryByText('New Browser Tab')).not.toBeInTheDocument()
    expect(screen.queryByText('Save Workspace Snapshot')).not.toBeInTheDocument()
    expect(screen.queryByText('Project Settings')).not.toBeInTheDocument()
    expect(screen.queryByText('App Preferences')).not.toBeInTheDocument()
    expect(screen.queryByText('Command History')).not.toBeInTheDocument()
    expect(screen.getByText('Switch to Project: Alpha')).toBeInTheDocument()
  })

  it('keeps recent commands visible when the search is empty', () => {
    recentCommandIds = ['open-command-history', 'project-alpha']

    renderPalette()

    expect(screen.getByText('Recent')).toBeInTheDocument()
    expect(screen.getAllByText('Command History')).toHaveLength(2)
    expect(screen.getAllByText('Switch to Project: Alpha')).toHaveLength(2)
  })

  it('runs a command when recent-command persistence fails', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    saveRecentCommand.mockRejectedValueOnce(new Error('storage unavailable'))
    const { props } = renderPalette()

    fireEvent.click(screen.getByText('Save Workspace Snapshot'))

    await waitFor(() => {
      expect(props.onClose).toHaveBeenCalled()
      expect(props.onSaveSnapshot).toHaveBeenCalled()
      expect(consoleWarn).toHaveBeenCalledWith(
        'Failed to save recent command',
        expect.any(Error)
      )
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
})
