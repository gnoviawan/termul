import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TitleBar } from './TitleBar'
import { useSidebarStore } from '@/stores/sidebar-store'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import * as appSettingsHooks from '@/hooks/use-app-settings'

const { mockUpdatePanelVisibility, mockToastError, mockWindowApi } = vi.hoisted(() => ({
  mockUpdatePanelVisibility: vi.fn(() => Promise.resolve()),
  mockToastError: vi.fn(),
  mockWindowApi: {
    onMaximizeChange: vi.fn(() => vi.fn()),
    minimize: vi.fn(),
    toggleMaximize: vi.fn().mockResolvedValue({ success: true, data: false }),
    close: vi.fn()
  }
}))

vi.mock('@/lib/api', () => ({
  windowApi: mockWindowApi
}))

vi.mock('sonner', () => ({
  toast: {
    error: mockToastError
  }
}))

describe('TitleBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(appSettingsHooks, 'useUpdatePanelVisibility').mockReturnValue(
      mockUpdatePanelVisibility
    )
    useSidebarStore.setState({ isVisible: true })
    useFileExplorerStore.setState({ isVisible: true })
  })

  function renderTitleBar() {
    return render(
      <MemoryRouter>
        <TitleBar />
      </MemoryRouter>
    )
  }

  it('toggles sidebar via persistence-aware updater on click', async () => {
    renderTitleBar()

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))

    await waitFor(() => {
      expect(mockUpdatePanelVisibility).toHaveBeenCalledWith('sidebarVisible', false)
    })
  })

  it('toggles file explorer via persistence-aware updater on click', async () => {
    renderTitleBar()

    fireEvent.click(screen.getByRole('button', { name: 'Hide file explorer' }))

    await waitFor(() => {
      expect(mockUpdatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', false)
    })
  })

  it('shows error toast when sidebar persistence update fails', async () => {
    mockUpdatePanelVisibility.mockRejectedValueOnce(new Error('persist failed'))

    renderTitleBar()

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('persist failed')
    })
  })

  it('shows error toast when file explorer persistence update fails', async () => {
    mockUpdatePanelVisibility.mockRejectedValueOnce(new Error('persist failed'))

    renderTitleBar()

    fireEvent.click(screen.getByRole('button', { name: 'Hide file explorer' }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('persist failed')
    })
  })
})
