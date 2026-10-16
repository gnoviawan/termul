import { act, render, renderHook, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetNativeWebviewOcclusionForTests,
  useNativeWebviewOccluded
} from '@/hooks/use-native-webview-occlusion'
import type { SSHWorkspaceState } from '@/layouts/workspace-layout/use-ssh-workspace'
import { useProjectStore } from '@/stores/project-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { useThemePickerStore } from '@/stores/theme-picker-store'
import { ShellFrame, type ShellFrameProps } from './ShellFrame'
import type { ShellRailProps } from './ShellRail'

const platformRef = vi.hoisted(() => ({ tauri: true, mac: false }))

vi.mock('@/lib/tauri-runtime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-runtime')>('@/lib/tauri-runtime')
  return { ...actual, isTauriContext: () => platformRef.tauri }
})
vi.mock('@/lib/platform', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform')>('@/lib/platform')
  return {
    ...actual,
    get isMac() {
      return platformRef.mac
    }
  }
})

vi.mock('@/components/ResizeEdges', () => ({ ResizeEdges: () => null }))
vi.mock('@/hooks/use-pane-dnd', () => ({
  PaneDndProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="pane-dnd">{children}</div>
  )
}))
const railProps: { current: ShellRailProps | null } = { current: null }
vi.mock('@/components/shell/ShellRail', () => ({
  ShellRail: (props: ShellRailProps) => {
    railProps.current = props
    return <div data-testid="rail" />
  }
}))
vi.mock('@/layouts/workspace-layout/ExplorerColumn', () => ({
  ExplorerColumn: () => <div data-testid="side-panel" />
}))

const mountSpy = vi.fn()
const unmountSpy = vi.fn()

function WorkspaceMainProbe(): React.JSX.Element {
  useEffect(() => {
    mountSpy()
    return () => unmountSpy()
  }, [])
  return <div data-testid="workspace-main" />
}

const ssh = {
  activeSSHProfileId: null,
  activeSSHProfile: null,
  handleSSHConnect: vi.fn(),
  handleSelectSSHProfile: vi.fn()
} as unknown as SSHWorkspaceState

const oneProject = { id: 'p1', name: 'One', color: 'blue', path: '/repo/one' } as const
const withProject: Partial<ShellFrameProps> = {
  projects: [oneProject],
  activeProject: oneProject,
  activeProjectId: 'p1'
}

function buildProps(overrides: Partial<ShellFrameProps> = {}): ShellFrameProps {
  return {
    projects: [],
    activeProject: undefined,
    activeProjectId: '',
    ssh,
    isShortcutMenuOpen: false,
    setIsShortcutMenuOpen: vi.fn(),
    setIsCommandPaletteOpen: vi.fn(),
    setIsNewProjectModalOpen: vi.fn(),
    onSelectProject: vi.fn(),
    handleAddGitTab: vi.fn(),
    handleAddGitHistoryTab: vi.fn(),
    handleToggleThemePicker: vi.fn(),
    handleOpenAgentChat: vi.fn(),
    handleOpenCanvas: vi.fn(),
    workspaceMain: <WorkspaceMainProbe />,
    appModals: <div data-testid="app-modals" />,
    ...overrides
  }
}

function renderFrame(overrides: Partial<ShellFrameProps> = {}, path = '/') {
  const view = (next: Partial<ShellFrameProps>) => (
    <MemoryRouter initialEntries={[path]}>
      <ShellFrame {...buildProps(next)} />
    </MemoryRouter>
  )
  const result = render(view(overrides))
  return {
    ...result,
    rerenderFrame: (next: Partial<ShellFrameProps>) => result.rerender(view(next))
  }
}

describe('ShellFrame', () => {
  beforeEach(() => {
    mountSpy.mockClear()
    unmountSpy.mockClear()
    resetNativeWebviewOcclusionForTests()
    resetShellLayoutStoreForTests()
    useShellLayoutStore.setState({ status: 'unavailable' })
    useProjectStore.setState({ projects: [] })
    useThemePickerStore.getState().close()
    railProps.current = null
    platformRef.tauri = true
    platformRef.mac = false
  })

  afterEach(() => {
    resetNativeWebviewOcclusionForTests()
    useThemePickerStore.getState().close()
  })

  it('renders the Rail, then the Side panel on the left of the main area', () => {
    renderFrame()

    const rail = screen.getByTestId('rail')
    const sidePanel = screen.getByTestId('side-panel')
    const main = screen.getByTestId('workspace-main').closest('main')
    expect(main).not.toBeNull()
    // DOM order: Rail, Side panel, main.
    expect(rail.compareDocumentPosition(sidePanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(
      sidePanel.compareDocumentPosition(main as Node) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    // Side panel and main share the drag-and-drop provider; the rail does not.
    const dnd = screen.getByTestId('pane-dnd')
    expect(dnd).toContainElement(sidePanel)
    expect(dnd).toContainElement(main)
    expect(dnd).not.toContainElement(rail)
    expect(screen.getByTestId('app-modals')).toBeInTheDocument()
  })

  it('wires the Rail: palette, canvas, shortcuts, theme picker and project props', () => {
    const setIsCommandPaletteOpen = vi.fn()
    const setIsShortcutMenuOpen = vi.fn()
    const handleOpenCanvas = vi.fn()
    const handleToggleThemePicker = vi.fn()
    const onSelectProject = vi.fn()
    renderFrame({
      ...withProject,
      isShortcutMenuOpen: true,
      setIsCommandPaletteOpen,
      setIsShortcutMenuOpen,
      handleOpenCanvas,
      handleToggleThemePicker,
      onSelectProject
    })

    const props = railProps.current as ShellRailProps
    expect(props.projects).toEqual([oneProject])
    expect(props.activeProject).toBe(oneProject)
    expect(props.activeProjectId).toBe('p1')
    expect(props.canOpenCanvas).toBe(true)
    expect(props.isShortcutsOpen).toBe(true)
    expect(props.isThemePickerOpen).toBe(false)

    props.onOpenCommandPalette()
    expect(setIsCommandPaletteOpen).toHaveBeenCalledWith(true)
    props.onOpenCanvas()
    expect(handleOpenCanvas).toHaveBeenCalledTimes(1)
    props.onShortcutsOpenChange(false)
    expect(setIsShortcutMenuOpen).toHaveBeenCalledWith(false)
    props.onToggleThemePicker?.()
    expect(handleToggleThemePicker).toHaveBeenCalledTimes(1)
    props.onSelectProject('p1')
    expect(onSelectProject).toHaveBeenCalledWith('p1')
  })

  it('cannot open the canvas without a project path', () => {
    renderFrame()
    expect((railProps.current as ShellRailProps).canOpenCanvas).toBe(false)
  })

  it('does not remount workspaceMain when the Rail flips between expanded and collapsed', () => {
    renderFrame()
    expect(mountSpy).toHaveBeenCalledTimes(1)

    act(() => useShellLayoutStore.setState({ railExpanded: false }))
    act(() => useShellLayoutStore.setState({ railExpanded: true }))
    act(() => useShellLayoutStore.setState({ railWidth: 280 }))

    expect(mountSpy).toHaveBeenCalledTimes(1)
    expect(unmountSpy).not.toHaveBeenCalled()
  })

  it('does not remount workspaceMain when the frame re-renders', () => {
    const { rerenderFrame } = renderFrame()
    expect(mountSpy).toHaveBeenCalledTimes(1)

    rerenderFrame({ isShortcutMenuOpen: true })
    rerenderFrame({ isShortcutMenuOpen: false })

    expect(mountSpy).toHaveBeenCalledTimes(1)
    expect(unmountSpy).not.toHaveBeenCalled()
  })

  it('occludes native webviews while the shortcuts menu is open', () => {
    const observer = renderHook(() => useNativeWebviewOccluded())
    const { rerenderFrame } = renderFrame()
    expect(observer.result.current).toBe(false)

    rerenderFrame({ isShortcutMenuOpen: true })
    expect(observer.result.current).toBe(true)

    rerenderFrame({ isShortcutMenuOpen: false })
    expect(observer.result.current).toBe(false)
  })

  it('occludes native webviews while the theme picker is open, until both occluders close', () => {
    const observer = renderHook(() => useNativeWebviewOccluded())
    const { rerenderFrame } = renderFrame({ isShortcutMenuOpen: true })

    act(() => useThemePickerStore.getState().open('termul'))
    expect(observer.result.current).toBe(true)

    // Shortcuts closes first: the theme picker still occludes.
    rerenderFrame({ isShortcutMenuOpen: false })
    expect(observer.result.current).toBe(true)

    act(() => useThemePickerStore.getState().close())
    expect(observer.result.current).toBe(false)
  })

  describe('top row', () => {
    const dragRegions = (): Element[] => [...document.querySelectorAll('[data-tauri-drag-region]')]

    it('tops the shell with an 8px drag gutter on desktop and none on web', () => {
      const { unmount } = renderFrame(withProject)
      const gutter = screen.getByTestId('top-gutter')
      expect(gutter).toHaveClass('h-2')
      expect(gutter).toHaveAttribute('data-tauri-drag-region')
      unmount()

      platformRef.tauri = false
      renderFrame(withProject)
      expect(screen.getByTestId('top-gutter')).not.toHaveAttribute('data-tauri-drag-region')
      expect(dragRegions()).toHaveLength(0)
    })

    it('runs the Rail full height beside the gutter: the gutter tops only the right column', () => {
      renderFrame(withProject)
      const rail = screen.getByTestId('rail')
      const gutter = screen.getByTestId('top-gutter')
      const row = screen.getByTestId('shell-row')

      // The Rail is not under the gutter and not inside the padded row.
      expect(rail.parentElement).not.toBe(gutter.parentElement)
      expect(row).not.toContainElement(rail)
      // The gutter and the row share the right column, beside the Rail.
      expect(gutter.parentElement).toBe(row.parentElement)
      expect(rail.parentElement).toBe(gutter.parentElement?.parentElement)
      // `pl-2` is the 8px gap between the Rail and the Side panel.
      expect(row).toHaveClass('pb-2', 'pr-2', 'pl-2')
      expect(row).toContainElement(screen.getByTestId('side-panel'))
    })

    it('renders the fallback bar with the controls when there is no project', () => {
      renderFrame()
      const bar = screen.getByTestId('top-row-fallback-bar')
      expect(bar).toHaveAttribute('data-tauri-drag-region')
      expect(screen.getAllByTestId('window-controls')).toHaveLength(1)
      expect(bar).toContainElement(screen.getByTestId('window-controls'))
      // Inside the main card, above workspaceMain.
      const main = screen.getByTestId('workspace-main').closest('main') as HTMLElement
      expect(main).toContainElement(bar)
      expect(
        bar.compareDocumentPosition(screen.getByTestId('workspace-main')) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    })

    it('renders the fallback bar on a routed page, not on a workspace route', () => {
      const { unmount } = renderFrame(withProject, '/snapshots')
      expect(screen.getByTestId('top-row-fallback-bar')).toBeInTheDocument()
      expect(screen.getAllByTestId('window-controls')).toHaveLength(1)
      unmount()

      renderFrame(withProject, '/c/chat-1')
      expect(screen.queryByTestId('top-row-fallback-bar')).not.toBeInTheDocument()
    })

    it('puts the Show side panel button in the fallback bar while the panel is hidden', () => {
      useProjectStore.setState({ projects: [oneProject] as never, activeProjectId: 'p1' })
      useShellLayoutStore.setState({ sidePanelVisible: false })
      const { unmount } = renderFrame(withProject, '/snapshots')
      expect(screen.getByTestId('top-row-fallback-bar')).toContainElement(
        screen.getByRole('button', { name: 'Show side panel' })
      )
      unmount()

      useShellLayoutStore.setState({ sidePanelVisible: true })
      renderFrame(withProject, '/snapshots')
      expect(screen.queryByRole('button', { name: 'Show side panel' })).not.toBeInTheDocument()
    })

    it('leaves the Show side panel button to the pane tab bars in panes mode', () => {
      useProjectStore.setState({ projects: [oneProject] as never, activeProjectId: 'p1' })
      useShellLayoutStore.setState({ sidePanelVisible: false })
      renderFrame(withProject)
      expect(screen.queryByRole('button', { name: 'Show side panel' })).not.toBeInTheDocument()
    })

    it('leaves the controls to the pane tab bars in panes mode', () => {
      renderFrame(withProject)
      expect(screen.queryByTestId('top-row-fallback-bar')).not.toBeInTheDocument()
      expect(screen.queryByTestId('window-controls')).not.toBeInTheDocument()
    })

    it('does not render the fallback bar in SSH mode (the SSH header owns the controls)', () => {
      renderFrame({
        ...withProject,
        ssh: { ...ssh, activeSSHProfile: { id: 's1' } } as unknown as SSHWorkspaceState
      })
      expect(screen.queryByTestId('top-row-fallback-bar')).not.toBeInTheDocument()
      expect(screen.queryByTestId('window-controls')).not.toBeInTheDocument()
    })

    it('renders no controls on macOS or web, even in the fallback bar', () => {
      platformRef.mac = true
      const { unmount } = renderFrame()
      expect(screen.getByTestId('top-row-fallback-bar')).toBeInTheDocument()
      expect(screen.queryByTestId('window-controls')).not.toBeInTheDocument()
      unmount()

      platformRef.mac = false
      platformRef.tauri = false
      renderFrame()
      expect(screen.queryByTestId('window-controls')).not.toBeInTheDocument()
      expect(dragRegions()).toHaveLength(0)
    })

    it('starts the main card below the traffic lights only with the Rail collapsed on macOS', () => {
      platformRef.mac = true
      useShellLayoutStore.setState({ railExpanded: false })
      const { unmount } = renderFrame(withProject)
      expect(screen.getByRole('main')).toHaveStyle({ marginTop: '36px' })
      unmount()

      useShellLayoutStore.setState({ railExpanded: true })
      const second = renderFrame(withProject)
      expect(screen.getByRole('main').style.marginTop).toBe('')
      second.unmount()

      platformRef.mac = false
      useShellLayoutStore.setState({ railExpanded: false })
      renderFrame(withProject)
      expect(screen.getByRole('main').style.marginTop).toBe('')
    })

    it('keeps workspaceMain mounted when the mode flips between fallback and panes', () => {
      const { rerenderFrame } = renderFrame()
      rerenderFrame(withProject)
      rerenderFrame({})
      expect(mountSpy).toHaveBeenCalledTimes(1)
      expect(unmountSpy).not.toHaveBeenCalled()
    })
  })
})
