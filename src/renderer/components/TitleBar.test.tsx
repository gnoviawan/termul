import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TitleBar } from './TitleBar'

const { mockWindowApi, platformState, maximizeRef, projectState, tauriState } = vi.hoisted(() => ({
  mockWindowApi: {
    onMaximizeChange: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn().mockResolvedValue({ success: true, data: false }),
    close: vi.fn()
  },
  platformState: { isMac: false },
  maximizeRef: { cb: null as null | ((maximized: boolean) => void) },
  projectState: { activeProject: null as null | { name: string } },
  tauriState: { isTauri: true }
}))

vi.mock('@/lib/api', () => ({
  windowApi: mockWindowApi
}))

vi.mock('@/lib/platform', () => ({
  get isMac() {
    return platformState.isMac
  }
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => tauriState.isTauri
}))

vi.mock('@/stores/project-store', () => ({
  useActiveProject: () => projectState.activeProject
}))

vi.mock('@/components/TitlebarPanelToggles', () => ({
  SidebarToggleButton: () => <button type="button">toggle-sidebar</button>,
  FileExplorerToggleButton: () => <button type="button">toggle-explorer</button>,
  titlebarNoDragStyle: { WebkitAppRegion: 'no-drag' }
}))

describe('TitleBar (window control strip)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    platformState.isMac = false
    projectState.activeProject = null
    maximizeRef.cb = null
    tauriState.isTauri = true
    mockWindowApi.onMaximizeChange.mockImplementation((cb: (maximized: boolean) => void) => {
      maximizeRef.cb = cb
      return vi.fn()
    })
  })

  it('renders window controls on Windows/Linux desktop', () => {
    render(<TitleBar />)

    expect(screen.getByRole('button', { name: 'Minimize window' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Maximize window' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close window' })).toBeInTheDocument()
  })

  it('renders the sidebar and file-explorer panel toggles on desktop', () => {
    render(<TitleBar />)

    expect(screen.getByRole('button', { name: 'toggle-sidebar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'toggle-explorer' })).toBeInTheDocument()
  })

  it('renders nothing on macOS desktop (native traffic lights)', () => {
    platformState.isMac = true
    const { container } = render(<TitleBar />)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button', { name: 'Minimize window' })).not.toBeInTheDocument()
  })

  it('renders the project-name strip on macOS web (not native traffic lights)', () => {
    platformState.isMac = true
    tauriState.isTauri = false
    projectState.activeProject = { name: 'mac-web-app' }

    render(<TitleBar />)

    // Web-on-mac must NOT return null — it falls through to the web branch.
    expect(screen.getByText('mac-web-app')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Minimize window' })).not.toBeInTheDocument()
  })

  it('minimizes the window on click', () => {
    render(<TitleBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }))

    expect(mockWindowApi.minimize).toHaveBeenCalledTimes(1)
  })

  it('toggles maximize on click', async () => {
    render(<TitleBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Maximize window' }))

    await waitFor(() => {
      expect(mockWindowApi.toggleMaximize).toHaveBeenCalledTimes(1)
    })
  })

  it('closes the window on click', () => {
    render(<TitleBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Close window' }))

    expect(mockWindowApi.close).toHaveBeenCalledTimes(1)
  })

  it('reflects maximize state via onMaximizeChange', () => {
    render(<TitleBar />)

    act(() => {
      maximizeRef.cb?.(true)
    })

    expect(screen.getByRole('button', { name: 'Restore window' })).toBeInTheDocument()
  })

  it('renders active project name when a project is active', () => {
    projectState.activeProject = { name: 'my-app' }

    render(<TitleBar />)

    expect(screen.getByText('my-app')).toBeInTheDocument()
  })

  it('does not render project name when no project is active', () => {
    projectState.activeProject = null

    render(<TitleBar />)

    expect(screen.queryByText('my-app')).not.toBeInTheDocument()
  })

  it('renders no window controls or panel toggles on web', () => {
    tauriState.isTauri = false

    render(<TitleBar />)

    expect(screen.queryByRole('button', { name: 'Minimize window' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Maximize window' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close window' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'toggle-sidebar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'toggle-explorer' })).not.toBeInTheDocument()
  })

  it('still renders the project name on web', () => {
    tauriState.isTauri = false
    projectState.activeProject = { name: 'web-app' }

    render(<TitleBar />)

    expect(screen.getByText('web-app')).toBeInTheDocument()
  })
})
