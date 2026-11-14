import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as appSettingsHooks from '@/hooks/use-app-settings'
import { selectTopRowRoles, type TopRowPlatform } from '@/lib/top-row'
import { useProjectStore } from '@/stores/project-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import type { Project } from '@/types/project'
import {
  ShowSidePanelSlot,
  SidePanelVisibilityButton,
  useShowSidePanelSlotVisible
} from './SidePanelVisibilityButtons'
import { TopRowProvider } from './top-row-context'

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

const updatePanelVisibility = vi.fn((panel: string, visible: boolean) => {
  if (panel === 'fileExplorerVisible') useShellLayoutStore.setState({ sidePanelVisible: visible })
  return Promise.resolve()
})

const project = (path: string): Project => ({ id: 'p1', name: 'Troupe', path }) as Project

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

describe('ShowSidePanelSlot expand-Rail toggle (Sidebar V2)', () => {
  const roles = selectTopRowRoles({
    root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
    fullscreenPaneId: null,
    mode: 'panes'
  })
  const mac: TopRowPlatform = { dragRegions: true, windowControls: false, trafficLights: true }
  const web: TopRowPlatform = { dragRegions: false, windowControls: false, trafficLights: false }

  const renderSlot = (platform: TopRowPlatform, railToggleInMain: boolean, inset = 0) =>
    render(
      <TopRowProvider
        roles={roles}
        platform={platform}
        mainStartInsetPx={inset}
        railToggleInMain={railToggleInMain}
      >
        <ShowSidePanelSlot />
      </TopRowProvider>
    )

  it('opens with the toggle right of the traffic lights (24px start padding) on macOS', () => {
    useShellLayoutStore.setState({ railExpanded: false, sidePanelVisible: true })
    renderSlot(mac, true, 24)
    const slot = screen.getByTestId('show-side-panel-slot')
    expect(slot.style.paddingLeft).toBe('24px')
    const toggle = within(slot).getByRole('button', { name: 'Expand or collapse projects' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveClass('size-7')
    expect(slot.firstElementChild).toBe(toggle)
  })

  it('shows the toggle with no inset elsewhere, and expands the Rail', () => {
    const expand = vi.fn(() => Promise.resolve())
    vi.spyOn(appSettingsHooks, 'useUpdatePanelVisibility').mockReturnValue(expand)
    useShellLayoutStore.setState({ railExpanded: false, sidePanelVisible: true })
    renderSlot(web, true)
    const slot = screen.getByTestId('show-side-panel-slot')
    expect(slot).toHaveClass('pl-2')
    fireEvent.click(within(slot).getByRole('button', { name: 'Expand or collapse projects' }))
    expect(expand).toHaveBeenCalledWith('sidebarVisible', true)
  })

  it('has no toggle while the Rail is expanded', () => {
    useShellLayoutStore.setState({ railExpanded: true, sidePanelVisible: true })
    renderSlot(mac, false)
    expect(screen.queryByTestId('show-side-panel-slot')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Expand or collapse projects' })).toBeNull()
  })

  it('counts the toggle as a reason to render the slot', () => {
    useShellLayoutStore.setState({ railExpanded: false, sidePanelVisible: true })
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <TopRowProvider roles={roles} platform={web} railToggleInMain>
        {children}
      </TopRowProvider>
    )
    const { result } = renderHook(() => useShowSidePanelSlotVisible(), { wrapper })
    expect(result.current).toBe(true)
  })
})
