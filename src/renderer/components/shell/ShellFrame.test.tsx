import { act, render, renderHook, screen, within } from '@testing-library/react'
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
const stripProps: {
  current: { sshOpen: boolean; onNewTerminal: () => void; onNewBrowserTab: () => void } | null
} = { current: null }
vi.mock('@/components/shell/tool-strip/ShellToolStrip', () => ({
  ShellToolStrip: (props: {
    sshOpen: boolean
    onNewTerminal: () => void
    onNewBrowserTab: () => void
  }) => {
    stripProps.current = props
    return <div data-testid="tool-strip" />
  }
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
    handleNewTerminal: vi.fn(),
    handleNewBrowserTab: vi.fn(),
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
    stripProps.current = null
    platformRef.tauri = true
    platformRef.mac = false
  })

  afterEach(() => {
    resetNativeWebviewOcclusionForTests()
    useThemePickerStore.getState().close()
  })

  it('lays out Rail | main area | Side panel | tool strip, edge to edge (Paper 2.2)', () => {
    renderFrame()

    const rail = screen.getByTestId('rail')
    const sidePanel = screen.getByTestId('side-panel')
    const strip = screen.getByTestId('tool-strip')
    const main = screen.getByTestId('workspace-main').closest('main') as HTMLElement
    expect(main).not.toBeNull()
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    expect(follows(rail, main)).toBe(true)
    expect(follows(main, sidePanel)).toBe(true)
    expect(follows(sidePanel, strip)).toBe(true)
    // No floating card: a 0.5px start hairline on the background surface.
    expect(main).toHaveClass('border-l-[0.5px]', 'border-border', 'bg-background')
    expect(main).not.toHaveClass('rounded-xl')
    // Main and Side panel share the drag-and-drop provider; Rail and strip do not.
    const dnd = screen.getByTestId('pane-dnd')
    expect(dnd).toContainElement(sidePanel)
    expect(dnd).toContainElement(main)
    expect(dnd).not.toContainElement(rail)
    expect(dnd).not.toContainElement(strip)
    expect(screen.getByTestId('app-modals')).toBeInTheDocument()
  })

  it('hands the tool strip the new terminal / browser handlers and the SSH mode', () => {
    const handleNewTerminal = vi.fn()
    const handleNewBrowserTab = vi.fn()
    renderFrame({ ...withProject, handleNewTerminal, handleNewBrowserTab })
    stripProps.current?.onNewTerminal()
    stripProps.current?.onNewBrowserTab()
    expect(handleNewTerminal).toHaveBeenCalledTimes(1)
    expect(handleNewBrowserTab).toHaveBeenCalledTimes(1)
    expect(stripProps.current?.sshOpen).toBeFalsy()
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

    it('has no top gutter: the shell row starts at the window top with no padding', () => {
      renderFrame(withProject)
      expect(screen.queryByTestId('top-gutter')).not.toBeInTheDocument()
      const row = screen.getByTestId('shell-row')
      expect(row.className).not.toMatch(/\bp[blrt]?-2\b/)
      expect(row).not.toContainElement(screen.getByTestId('rail'))
      expect(row).toContainElement(screen.getByTestId('side-panel'))
      expect(row).toContainElement(screen.getByTestId('tool-strip'))
    })

    it('renders the fallback bar with the controls spacer when there is no project', () => {
      renderFrame()
      const bar = screen.getByTestId('top-row-fallback-bar')
      expect(bar).toHaveAttribute('data-tauri-drag-region')
      expect(bar).toContainElement(screen.getByTestId('window-controls-inset'))
      // Inside the main card, above workspaceMain.
      const main = screen.getByTestId('workspace-main').closest('main') as HTMLElement
      expect(main).toContainElement(bar)
      expect(
        bar.compareDocumentPosition(screen.getByTestId('workspace-main')) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    })

    it('draws the window controls once, in the top-right corner above the tool strip', () => {
      renderFrame()
      const controls = screen.getByTestId('window-controls')
      expect(screen.getAllByTestId('window-controls')).toHaveLength(1)
      expect(screen.getByTestId('shell-row')).toContainElement(controls)
      expect(screen.getByTestId('shell-row')).toHaveClass('relative')
      expect(controls).toHaveClass('absolute', 'top-0', 'right-0', 'h-11')
      expect(controls).not.toHaveAttribute('data-tauri-drag-region')
      // After the strip in the DOM, so it paints over the strip's top.
      expect(
        screen.getByTestId('tool-strip').compareDocumentPosition(controls) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    })

    it('renders the fallback bar on a routed page, not on a workspace route', () => {
      const { unmount } = renderFrame(withProject, '/snapshots')
      expect(screen.getByTestId('top-row-fallback-bar')).toBeInTheDocument()
      expect(screen.getByTestId('window-controls-inset')).toBeInTheDocument()
      unmount()

      renderFrame(withProject, '/c/chat-1')
      expect(screen.queryByTestId('top-row-fallback-bar')).not.toBeInTheDocument()
    })

    it('puts the expand-Rail toggle in the fallback bar while the Rail is collapsed', () => {
      useShellLayoutStore.setState({ railExpanded: false })
      const { unmount } = renderFrame(withProject, '/snapshots')
      expect(screen.getByTestId('top-row-fallback-bar')).toContainElement(
        screen.getByRole('button', { name: 'Expand or collapse projects' })
      )
      expect(screen.queryByRole('button', { name: 'Show side panel' })).not.toBeInTheDocument()
      unmount()

      useShellLayoutStore.setState({ railExpanded: true })
      renderFrame(withProject, '/snapshots')
      expect(screen.queryByTestId('top-row-start-slot')).not.toBeInTheDocument()
    })

    it('keeps the controls in the corner in panes mode, with no fallback bar', () => {
      renderFrame(withProject)
      expect(screen.queryByTestId('top-row-fallback-bar')).not.toBeInTheDocument()
      expect(screen.getAllByTestId('window-controls')).toHaveLength(1)
    })

    it('does not render the fallback bar in SSH mode (the SSH header is the top row)', () => {
      renderFrame({
        ...withProject,
        ssh: { ...ssh, activeSSHProfile: { id: 's1' } } as unknown as SSHWorkspaceState
      })
      expect(screen.queryByTestId('top-row-fallback-bar')).not.toBeInTheDocument()
      expect(screen.getAllByTestId('window-controls')).toHaveLength(1)
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

    it('keeps the main area at the top and pads the top row under the traffic lights', () => {
      platformRef.mac = true
      useShellLayoutStore.setState({ railExpanded: false })
      const { unmount } = renderFrame()
      expect(screen.getByRole('main').style.marginTop).toBe('')
      expect(screen.getByTestId('top-row-start-slot')).toHaveStyle({ paddingLeft: '24px' })
      unmount()

      useShellLayoutStore.setState({ railExpanded: true })
      const second = renderFrame()
      expect(screen.queryByTestId('top-row-start-slot')).not.toBeInTheDocument()
      second.unmount()

      // Elsewhere there is no inset, but the collapsed Rail's expand toggle
      // still opens the top row (Sidebar V2).
      platformRef.mac = false
      useShellLayoutStore.setState({ railExpanded: false })
      renderFrame()
      const slot = screen.getByTestId('top-row-start-slot')
      expect(slot.style.paddingLeft).toBe('')
      expect(
        within(slot).getByRole('button', { name: 'Expand or collapse projects' })
      ).toBeInTheDocument()
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
