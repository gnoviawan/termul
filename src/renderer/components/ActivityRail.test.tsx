import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as appSettingsHooks from '@/hooks/use-app-settings'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useSidebarStore } from '@/stores/sidebar-store'
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
    useSidebarStore.setState({ isVisible: true })
    useFileExplorerStore.setState({ isVisible: true })
    useSSHPanelStore.setState({ isVisible: true })
  })

  function renderRail() {
    return render(
      <MemoryRouter>
        <ActivityRail />
      </MemoryRouter>
    )
  }

  it('toggles sidebar via persistence-aware updater on click', async () => {
    renderRail()

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))

    await waitFor(() => {
      expect(mockUpdatePanelVisibility).toHaveBeenCalledWith('sidebarVisible', false)
    })
  })

  it('toggles file explorer via persistence-aware updater on click', async () => {
    renderRail()

    fireEvent.click(screen.getByRole('button', { name: 'Hide file explorer' }))

    await waitFor(() => {
      expect(mockUpdatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', false)
    })
  })

  it('shows error toast when sidebar persistence update fails', async () => {
    mockUpdatePanelVisibility.mockRejectedValueOnce(new Error('persist failed'))

    renderRail()

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('persist failed')
    })
  })

  it('shows error toast when file explorer persistence update fails', async () => {
    mockUpdatePanelVisibility.mockRejectedValueOnce(new Error('persist failed'))

    renderRail()

    fireEvent.click(screen.getByRole('button', { name: 'Hide file explorer' }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('persist failed')
    })
  })

  it('navigates to preferences on click', () => {
    renderRail()

    fireEvent.click(screen.getByRole('button', { name: 'Open preferences' }))

    expect(mockNavigate).toHaveBeenCalledWith('/preferences')
  })

  it('exposes the keyboard shortcuts trigger', () => {
    renderRail()

    expect(screen.getByRole('button', { name: 'Open keyboard shortcuts menu' })).toBeInTheDocument()
  })

  it('renders the Termul brand mark', () => {
    renderRail()

    expect(screen.getByRole('img', { name: 'Termul' })).toBeInTheDocument()
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
})
