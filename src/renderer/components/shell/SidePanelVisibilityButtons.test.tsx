import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as appSettingsHooks from '@/hooks/use-app-settings'
import { useProjectStore } from '@/stores/project-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import type { Project } from '@/types/project'
import { ShowSidePanelSlot, SidePanelVisibilityButton } from './SidePanelVisibilityButtons'

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

const updatePanelVisibility = vi.fn((panel: string, visible: boolean) => {
  if (panel === 'fileExplorerVisible') useShellLayoutStore.setState({ sidePanelVisible: visible })
  return Promise.resolve()
})

const project = (path: string): Project => ({ id: 'p1', name: 'Termul', path }) as Project

beforeEach(() => {
  vi.clearAllMocks()
  resetShellLayoutStoreForTests()
  useShellLayoutStore.setState({ status: 'unavailable' })
  useProjectStore.setState({ projects: [project('/repo')], activeProjectId: 'p1' })
  vi.spyOn(appSettingsHooks, 'useUpdatePanelVisibility').mockReturnValue(updatePanelVisibility)
})

describe('SidePanelVisibilityButton hide', () => {
  it('hides the panel and names its shortcut', () => {
    render(<SidePanelVisibilityButton action="hide" />)
    const button = screen.getByRole('button', { name: 'Hide side panel' })
    expect(button.getAttribute('title')).toMatch(/^Hide side panel \(.*B\)$/)
    fireEvent.click(button)
    expect(updatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', false)
  })

  it('toasts the generic message when the error is not an Error', async () => {
    updatePanelVisibility.mockRejectedValueOnce('nope')
    render(<SidePanelVisibilityButton action="hide" />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide side panel' }))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith('Failed to update side panel visibility')
    )
  })
})

describe('SidePanelVisibilityButton show', () => {
  it('shows the hidden panel', () => {
    useShellLayoutStore.setState({ sidePanelVisible: false })
    render(<SidePanelVisibilityButton action="show" />)
    fireEvent.click(screen.getByRole('button', { name: 'Show side panel' }))
    expect(updatePanelVisibility).toHaveBeenCalledWith('fileExplorerVisible', true)
  })
})

describe('ShowSidePanelSlot', () => {
  it('renders nothing while the panel is visible', () => {
    useShellLayoutStore.setState({ sidePanelVisible: true })
    render(<ShowSidePanelSlot />)
    expect(screen.queryByTestId('show-side-panel-slot')).toBeNull()
  })

  it('renders the Show button while the panel is hidden', () => {
    useShellLayoutStore.setState({ sidePanelVisible: false })
    render(<ShowSidePanelSlot />)
    const slot = screen.getByTestId('show-side-panel-slot')
    expect(slot).toContainElement(screen.getByRole('button', { name: 'Show side panel' }))
  })

  it('renders nothing when the active project has no folder to show', () => {
    useShellLayoutStore.setState({ sidePanelVisible: false })
    useProjectStore.setState({ projects: [project('')] })
    render(<ShowSidePanelSlot />)
    expect(screen.queryByTestId('show-side-panel-slot')).toBeNull()
  })
})
