import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as appSettingsHooks from '@/hooks/use-app-settings'
import { useGitStatusStore } from '@/stores/git-status-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { useSSHPanelStore } from '@/stores/ssh-panel-store'
import { ActivityRail } from './ActivityRail'

const { mockUpdatePanelVisibility, mockToastError, mockNavigate, platformState } = vi.hoisted(
  () => ({
    mockUpdatePanelVisibility: vi.fn(() => Promise.resolve()),
    mockToastError: vi.fn(),
    mockNavigate: vi.fn(),
    platformState: { isMac: false }
  })
)

const { runningRef } = vi.hoisted(() => ({ runningRef: { current: new Set<string>() } }))

vi.mock('@/hooks/use-agent-chat-attention', () => ({
  useAgentChatProjectSignals: () => ({
    attentionCounts: {},
    firstNeedsYouSessionId: {},
    runningProjectIds: runningRef.current
  })
}))

vi.mock('sonner', () => ({
  toast: {
    error: mockToastError
  }
}))

vi.mock('@/lib/platform', () => ({
  get isMac() {
    return platformState.isMac
  }
}))

// Mutable: defaults to desktop so existing tests pass. Web-mode tests set
// this to false to verify the SSH rail button's disabled-with-reason gate.
const { tauriRef } = vi.hoisted(() => ({ tauriRef: { current: true as boolean } }))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => tauriRef.current
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate
  }
})

describe('ActivityRail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    platformState.isMac = false
    vi.spyOn(appSettingsHooks, 'useUpdatePanelVisibility').mockReturnValue(
      mockUpdatePanelVisibility
    )
    useSSHPanelStore.setState({ isVisible: true })
    useSettingsModalStore.setState({ view: null })
  })

  function renderRail() {
    return render(
      <MemoryRouter>
        <ActivityRail />
      </MemoryRouter>
    )
  }

  it('does not render sidebar or file-explorer toggles (moved to titlebar)', () => {
    renderRail()

    expect(screen.queryByRole('button', { name: /sidebar/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /file explorer/i })).not.toBeInTheDocument()
  })
  it('opens the app preferences modal on click', () => {
    renderRail()

    fireEvent.click(screen.getByRole('button', { name: 'Open preferences' }))

    expect(useSettingsModalStore.getState().view).toBe('app')
  })

  it('exposes the keyboard shortcuts trigger', () => {
    renderRail()

    expect(screen.getByRole('button', { name: 'Open keyboard shortcuts menu' })).toBeInTheDocument()
  })

  it('disables color themes when no toggle handler is provided', () => {
    renderRail()

    const themeButton = screen.getByRole('button', { name: 'Color themes' })
    expect(themeButton).toBeDisabled()
    expect(themeButton).toHaveAttribute('aria-disabled', 'true')
    expect(themeButton).not.toHaveAttribute('aria-pressed')
  })

  it('toggles color themes when a toggle handler is provided', () => {
    const onToggleThemePicker = vi.fn()
    render(
      <MemoryRouter>
        <ActivityRail isThemePickerOpen onToggleThemePicker={onToggleThemePicker} />
      </MemoryRouter>
    )

    const themeButton = screen.getByRole('button', { name: 'Color themes' })
    expect(themeButton).not.toBeDisabled()
    expect(themeButton).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(themeButton)

    expect(onToggleThemePicker).toHaveBeenCalledTimes(1)
  })

  it('renders the Termul brand mark', () => {
    renderRail()

    expect(screen.getByRole('img', { name: 'Termul' })).toBeInTheDocument()
  })

  it('keeps the brand row draggable on macOS for top-left window moves', () => {
    platformState.isMac = true

    renderRail()

    const rail = screen.getByRole('navigation', { name: 'Global actions' })
    expect(rail.className).not.toContain('pt-[32px]')
    expect(rail.querySelector('[data-tauri-drag-region="true"]')).not.toBeNull()
  })

  it('opens the command palette via the projects action', () => {
    const onOpenCommandPalette = vi.fn()
    render(
      <MemoryRouter>
        <ActivityRail onOpenCommandPalette={onOpenCommandPalette} />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open projects' }))

    expect(onOpenCommandPalette).toHaveBeenCalledTimes(1)
  })

  it('opens git changes when a project is available', () => {
    const onOpenGitChanges = vi.fn()
    render(
      <MemoryRouter>
        <ActivityRail onOpenGitChanges={onOpenGitChanges} canOpenGitChanges />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open git changes' }))

    expect(onOpenGitChanges).toHaveBeenCalledTimes(1)
  })

  it('disables git changes when no project is available', () => {
    const onOpenGitChanges = vi.fn()
    render(
      <MemoryRouter>
        <ActivityRail onOpenGitChanges={onOpenGitChanges} canOpenGitChanges={false} />
      </MemoryRouter>
    )

    const gitButton = screen.getByRole('button', { name: 'Open git changes' })
    expect(gitButton).toBeDisabled()
    fireEvent.click(gitButton)
    expect(onOpenGitChanges).not.toHaveBeenCalled()
  })

  it('opens a new agent chat when a project is available', () => {
    const onOpenAgentChat = vi.fn()
    render(
      <MemoryRouter>
        <ActivityRail onOpenAgentChat={onOpenAgentChat} canOpenAgentChat />
      </MemoryRouter>
    )

    fireEvent.click(screen.getByRole('button', { name: 'New agent chat' }))

    expect(onOpenAgentChat).toHaveBeenCalledTimes(1)
  })

  it('opens the canvas when a project is available', () => {
    const onOpenCanvas = vi.fn()
    render(
      <MemoryRouter>
        <ActivityRail onOpenCanvas={onOpenCanvas} canOpenCanvas />
      </MemoryRouter>
    )

    const canvasButton = screen.getByRole('button', { name: 'Open canvas' })
    expect(canvasButton).not.toBeDisabled()
    // Radix tooltip replaces the native title (redesign).
    expect(canvasButton).not.toHaveAttribute('title')

    fireEvent.click(canvasButton)

    expect(onOpenCanvas).toHaveBeenCalledTimes(1)
  })

  it('disables the canvas action when no project is available', () => {
    const onOpenCanvas = vi.fn()
    render(
      <MemoryRouter>
        <ActivityRail onOpenCanvas={onOpenCanvas} canOpenCanvas={false} />
      </MemoryRouter>
    )

    const canvasButton = screen.getByRole('button', { name: 'Open canvas' })
    expect(canvasButton).toBeDisabled()
    expect(canvasButton).not.toHaveAttribute('title')
    expect(canvasButton.className).toContain('disabled:opacity-40')
    fireEvent.click(canvasButton)
    expect(onOpenCanvas).not.toHaveBeenCalled()
  })

  it('disables the canvas action when no handler is provided', () => {
    render(
      <MemoryRouter>
        <ActivityRail canOpenCanvas />
      </MemoryRouter>
    )

    expect(screen.getByRole('button', { name: 'Open canvas' })).toBeDisabled()
  })

  it('disables new agent chat when no project is available', () => {
    const onOpenAgentChat = vi.fn()
    render(
      <MemoryRouter>
        <ActivityRail onOpenAgentChat={onOpenAgentChat} canOpenAgentChat={false} />
      </MemoryRouter>
    )

    const chatButton = screen.getByRole('button', { name: 'New agent chat' })
    expect(chatButton).toBeDisabled()
    fireEvent.click(chatButton)
    expect(onOpenAgentChat).not.toHaveBeenCalled()
  })

  it('toggles the SSH panel via persistence-aware updater on click', async () => {
    renderRail()

    fireEvent.click(screen.getByRole('button', { name: 'Hide SSH panel' }))

    await waitFor(() => {
      expect(mockUpdatePanelVisibility).toHaveBeenCalledWith('sshPanelVisible', false)
    })
  })

  it('shows error toast when SSH panel persistence update fails', async () => {
    mockUpdatePanelVisibility.mockRejectedValueOnce(new Error('persist failed'))

    renderRail()

    fireEvent.click(screen.getByRole('button', { name: 'Hide SSH panel' }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('persist failed')
    })
  })

  it('hides the SSH rail button entirely on web (#843)', () => {
    const prev = tauriRef.current
    tauriRef.current = false
    try {
      renderRail()
      const sshButton = screen.queryByRole('button', { name: /SSH panel/i })
      expect(sshButton).not.toBeInTheDocument()
    } finally {
      tauriRef.current = prev
    }
  })

  describe('redesign states', () => {
    it('marks a pressed view with the keycap surface and no accent fill', () => {
      useSettingsModalStore.setState({ view: 'app' })
      renderRail()
      const prefs = screen.getByRole('button', { name: 'Open preferences' })
      expect(prefs).toHaveAttribute('aria-pressed', 'true')
      expect(prefs.className).toContain('keycap')
      expect(prefs.className).toContain('size-9')
      expect(prefs.className).not.toMatch(/bg-(secondary|accent|primary)/)
    })

    it('shows the changed-file count on the git button for the active project', () => {
      const prevProjects = useProjectStore.getState()
      useProjectStore.setState({
        projects: [{ id: 'p1', name: 'P', path: '/repo', color: 'blue' }],
        activeProjectId: 'p1'
      })
      useGitStatusStore.setState({
        statuses: {
          '/repo': [
            { path: 'a.ts', staged: true },
            { path: 'a.ts', staged: false },
            { path: 'b.ts', staged: false }
          ] as never
        }
      })
      try {
        render(
          <MemoryRouter>
            <ActivityRail onOpenGitChanges={vi.fn()} canOpenGitChanges />
          </MemoryRouter>
        )
        expect(screen.getByTestId('rail-git-badge')).toHaveTextContent('2')
      } finally {
        useGitStatusStore.setState({ statuses: {} })
        useProjectStore.setState({
          projects: prevProjects.projects,
          activeProjectId: prevProjects.activeProjectId
        })
      }
    })

    it('shows a live dot on new agent chat while a chat in the active project runs', () => {
      const prev = useProjectStore.getState()
      useProjectStore.setState({
        projects: [{ id: 'p1', name: 'P', path: '/repo', color: 'blue' }],
        activeProjectId: 'p1'
      })
      runningRef.current = new Set(['p1'])
      try {
        renderRail()
        expect(screen.getByTestId('rail-agent-live-dot').className).toContain('bg-primary')
      } finally {
        runningRef.current = new Set()
        useProjectStore.setState({ projects: prev.projects, activeProjectId: prev.activeProjectId })
      }
    })

    it('shows no git badge without changes', () => {
      renderRail()
      expect(screen.queryByTestId('rail-git-badge')).toBeNull()
    })
  })
})
