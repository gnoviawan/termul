import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { useSidebarStore } from '@/stores/sidebar-store'
import { FileExplorerToggleButton, SidebarToggleButton } from './TitlebarPanelToggles'

const { mockUpdatePanelVisibility, mockToastError } = vi.hoisted(() => ({
  mockUpdatePanelVisibility: vi.fn(() => Promise.resolve()),
  mockToastError: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: mockToastError
  }
}))

vi.mock('@/hooks/use-app-settings', () => ({
  useUpdatePanelVisibility: () => mockUpdatePanelVisibility
}))

describe('TitlebarPanelToggles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSidebarStore.setState({ isVisible: true })
    useFileExplorerStore.setState({ isVisible: true })
  })

  it('toggles sidebar via persistence-aware updater on click', async () => {
    render(<SidebarToggleButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))

    await waitFor(() => {
      expect(mockUpdatePanelVisibility).toHaveBeenCalledWith('sidebarVisible', false)
    })
  })

  it('toggles file explorer via persistence-aware updater on click', async () => {
    render(<FileExplorerToggleButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Hide file explorer' }))

    await waitFor(() => {
      expect(mockUpdatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', false)
    })
  })

  it('shows error toast when sidebar persistence update fails', async () => {
    mockUpdatePanelVisibility.mockRejectedValueOnce(new Error('persist failed'))

    render(<SidebarToggleButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('persist failed')
    })
  })

  it('shows error toast when file explorer persistence update fails', async () => {
    mockUpdatePanelVisibility.mockRejectedValueOnce(new Error('persist failed'))

    render(<FileExplorerToggleButton />)

    fireEvent.click(screen.getByRole('button', { name: 'Hide file explorer' }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('persist failed')
    })
  })

  it('reflects hidden state in label and pressed state when not visible', () => {
    useSidebarStore.setState({ isVisible: false })
    useFileExplorerStore.setState({ isVisible: false })

    render(
      <>
        <SidebarToggleButton />
        <FileExplorerToggleButton />
      </>
    )

    const sidebarButton = screen.getByRole('button', { name: 'Show sidebar' })
    const explorerButton = screen.getByRole('button', { name: 'Show file explorer' })

    expect(sidebarButton).toHaveAttribute('aria-pressed', 'false')
    expect(explorerButton).toHaveAttribute('aria-pressed', 'false')
  })
})
