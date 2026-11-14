import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as appSettingsHooks from '@/hooks/use-app-settings'
import {
  resetNativeWebviewOcclusionForTests,
  useNativeWebviewOccluded
} from '@/hooks/use-native-webview-occlusion'
import { mockSessionIndexEntry } from '@/lib/test-utils/acp'
import { useAcpStore } from '@/stores/acp-store'
import { useGitStatusStore } from '@/stores/git-status-store'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { useSSHStore } from '@/stores/ssh-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import { ShellRail, type ShellRailProps } from './ShellRail'

const { mockNavigate, mockToastError, tauriRef, macRef, reconcilerSpy, mockLog } = vi.hoisted(
  () => ({
    mockLog: vi.fn(),
    mockNavigate: vi.fn(),
    mockToastError: vi.fn(),
    tauriRef: { current: true as boolean },
    macRef: { current: false as boolean },
    reconcilerSpy: vi.fn()
  })
)

vi.mock('sonner', () => ({ toast: { error: mockToastError } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mockLog }))

vi.mock('@/lib/tauri-runtime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-runtime')>('@/lib/tauri-runtime')
  return { ...actual, isTauriContext: () => tauriRef.current }
})

vi.mock('@/lib/platform', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform')>('@/lib/platform')
  return {
    ...actual,
    get isMac() {
      return macRef.current
    }
  }
})

vi.mock('@/hooks/use-worktree-reconciler', () => ({
  useWorktreeReconciler: (projectId: string) => reconcilerSpy(projectId)
}))

vi.mock('@/hooks/use-agent-chat-attention', () => ({
  useAgentChatProjectSignals: () => ({
    attentionCounts: {},
    firstNeedsYouSessionId: {},
    needsYouChats: new Map<string, string>(),
    workingProjectIds: new Set<string>(),
    runningProjectIds: new Set<string>()
  })
}))

vi.mock('@/components/sidebar/ssh-section', () => ({
  SSHResizableSection: () => <div data-testid="ssh-section" />
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

const projects: Project[] = [
  { id: 'p1', name: 'Alpha', color: 'blue', path: '/repo/alpha', isGitRepo: true },
  { id: 'p2', name: 'Beta', color: 'green', path: '/repo/beta', isGitRepo: true },
  { id: 'p3', name: 'Old', color: 'red', path: '/repo/old', isArchived: true }
]

function buildProps(overrides: Partial<ShellRailProps> = {}): ShellRailProps {
  return {
    projects,
    activeProjectId: 'p1',
    onSelectProject: vi.fn(),
    onNewProject: vi.fn(),
    onSSHConnect: vi.fn(),
    onSelectSSHProfile: vi.fn(),
    activeSSHProfileId: null,
    onOpenCommandPalette: vi.fn(),
    onOpenCanvas: vi.fn(),
    canOpenCanvas: true,
    isShortcutsOpen: false,
    onShortcutsOpenChange: vi.fn(),
    isThemePickerOpen: false,
    onToggleThemePicker: vi.fn(),
    ...overrides
  }
}

function renderRail(overrides: Partial<ShellRailProps> = {}) {
  const props = buildProps(overrides)
  const view = render(
    <MemoryRouter>
      <ShellRail {...props} />
    </MemoryRouter>
  )
  return {
    ...view,
    props,
    rerenderRail: (next: Partial<ShellRailProps>) => {
      Object.assign(props, next)
      view.rerender(
        <MemoryRouter>
          <ShellRail {...props} />
        </MemoryRouter>
      )
    }
  }
}

const updatePanelVisibility = vi.fn((panel: string, visible: boolean) => {
  if (panel === 'sidebarVisible') useShellLayoutStore.getState().setRailExpanded(visible)
  return Promise.resolve()
})

describe('ShellRail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // cmdk scrolls the highlighted row into view; jsdom has no layout.
    Element.prototype.scrollIntoView = vi.fn()
    tauriRef.current = true
    resetNativeWebviewOcclusionForTests()
    resetShellLayoutStoreForTests()
    // `unavailable` keeps the store usable in memory without writing.
    useShellLayoutStore.setState({ status: 'unavailable' })
    useSettingsModalStore.setState({ view: null })
    useSSHStore.setState({ workspaceOpen: false })
    useProjectStore.setState({ projects, groups: [] })
    useGitStatusStore.setState({
      diffStats: {},
      watchDiffStat: vi.fn(() => () => {}),
      refreshDiffStat: vi.fn(() => Promise.resolve())
    })
    vi.spyOn(appSettingsHooks, 'useUpdatePanelVisibility').mockReturnValue(updatePanelVisibility)
  })

  describe('expanded', () => {
    it('is a Projects nav with New chat, Search, Canvas, the Projects section, SSH and the footer', () => {
      renderRail()

      const nav = screen.getByRole('navigation', { name: 'Projects' })
      expect(within(nav).getByRole('button', { name: 'New chat' })).toBeInTheDocument()
      expect(within(nav).getByRole('button', { name: 'Search' })).toBeInTheDocument()
      expect(within(nav).getByRole('button', { name: 'Open canvas' })).toBeInTheDocument()
      expect(within(nav).getByText('Projects')).toBeInTheDocument()
      expect(within(nav).getByText('Alpha')).toBeInTheDocument()
      expect(within(nav).getByText('Beta')).toBeInTheDocument()
      expect(within(nav).queryByText('Old')).not.toBeInTheDocument()
      expect(within(nav).getByTestId('ssh-section')).toBeInTheDocument()
      expect(within(nav).getByRole('button', { name: 'Settings' })).toBeInTheDocument()
      expect(within(nav).getByRole('button', { name: 'Color themes' })).toBeInTheDocument()
      expect(
        within(nav).getByRole('button', { name: 'Open keyboard shortcuts menu' })
      ).toBeInTheDocument()
      // No chat list when the active project has no chats.
      expect(within(nav).queryByTestId('rail-project-chats')).not.toBeInTheDocument()
      // The collapsed-only controls are absent.
      expect(within(nav).queryByRole('button', { name: /Switch project/ })).not.toBeInTheDocument()
      expect(screen.getByTestId('shell-rail')).toHaveStyle({ width: '248px' })
    })

    it('shows no shortcut chip on the nav rows; the shortcut is in the tooltip', async () => {
      renderRail()
      const search = screen.getByRole('button', { name: 'Search' })
      expect(search.querySelector('kbd')).toBeNull()
      expect(screen.getByRole('button', { name: 'New chat' }).querySelector('kbd')).toBeNull()
      fireEvent.focus(search)
      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip).toHaveTextContent('Ctrl+K')
    })

    it('follows a custom command palette binding', async () => {
      const { shortcuts } = useKeyboardShortcutsStore.getState()
      useKeyboardShortcutsStore.setState({
        shortcuts: {
          ...shortcuts,
          commandPalette: { ...shortcuts.commandPalette, customKey: 'ctrl+p' }
        }
      })
      renderRail()
      fireEvent.focus(screen.getByRole('button', { name: 'Search' }))
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Ctrl+P')
      useKeyboardShortcutsStore.getState().resetShortcut('commandPalette')
    })

    it('opens the launcher from New chat and logs it once from the Rail', () => {
      const showAgentLauncher = vi.fn()
      useWorkspaceStore.setState({ activePaneId: 'pane-1', showAgentLauncher })
      renderRail()
      fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
      expect(showAgentLauncher).toHaveBeenCalledWith('pane-1')
      expect(mockLog).toHaveBeenCalledTimes(1)
      expect(mockLog).toHaveBeenCalledWith({
        level: 'info',
        source: 'Rail',
        message: '[rail] new chat'
      })
    })

    it('nests the chats under the active project only', () => {
      useAcpStore.setState({
        sessions: {},
        agentConfigs: [],
        sessionIndex: [
          mockSessionIndexEntry({ id: 'a', title: 'Chat a', projectId: 'p1', cwd: '/repo/alpha' }),
          mockSessionIndexEntry({ id: 'b', title: 'Chat b', projectId: 'p2', cwd: '/repo/beta' })
        ]
      })
      renderRail()
      const alpha = screen.getByTestId('project-item-p1').parentElement as HTMLElement
      expect(within(alpha).getByRole('list', { name: 'Chats in Alpha' })).toBeInTheDocument()
      expect(within(alpha).getByRole('button', { name: 'Chat a' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Chat b' })).not.toBeInTheDocument()
      useAcpStore.setState({ sessionIndex: [] })
    })

    it('opens the command palette and the canvas from their rows', () => {
      const { props } = renderRail()

      fireEvent.click(screen.getByRole('button', { name: 'Search' }))
      expect(props.onOpenCommandPalette).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByRole('button', { name: 'Open canvas' }))
      expect(props.onOpenCanvas).toHaveBeenCalledTimes(1)
    })

    it('disables Canvas with a hint when no project has a path', async () => {
      const { props } = renderRail({ canOpenCanvas: false, activeProjectId: '' })
      const canvas = screen.getByRole('button', { name: 'Open canvas' })
      expect(canvas).toBeDisabled()

      fireEvent.click(canvas)
      expect(props.onOpenCanvas).not.toHaveBeenCalled()

      fireEvent.focus(canvas.parentElement as HTMLElement)
      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip).toHaveTextContent('Open a project first')
    })

    it('opens Settings from the footer row, with the resolved shortcut in its tooltip', async () => {
      const { shortcuts } = useKeyboardShortcutsStore.getState()
      useKeyboardShortcutsStore.setState({
        shortcuts: {
          ...shortcuts,
          settings: { id: 'settings', label: 'Settings', description: 'x', defaultKey: 'ctrl+,' }
        }
      })
      renderRail()

      const settings = screen.getByRole('button', { name: 'Settings' })
      expect(settings.querySelector('kbd')).toBeNull()

      fireEvent.focus(settings)
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Ctrl+,')

      fireEvent.click(settings)
      expect(useSettingsModalStore.getState().view).toBe('app')
      expect(settings).toHaveAttribute('aria-pressed', 'true')
      expect(settings).toHaveClass('keycap')

      const { settings: _removed, ...rest } = useKeyboardShortcutsStore.getState().shortcuts
      useKeyboardShortcutsStore.setState({ shortcuts: rest })
    })

    it('toggles the color theme picker and the shortcuts menu from the footer', () => {
      const { props } = renderRail()

      fireEvent.click(screen.getByRole('button', { name: 'Color themes' }))
      expect(props.onToggleThemePicker).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByRole('button', { name: 'Open keyboard shortcuts menu' }))
      expect(props.onShortcutsOpenChange).toHaveBeenCalledWith(true)
    })

    it('ends the Rail header with the one 28px toggle, after the centered Troupe mark', () => {
      for (const tauri of [true, false]) {
        tauriRef.current = tauri
        const { unmount } = renderRail()
        const header = screen.getByTestId('rail-header')
        expect(header).toHaveClass('h-12', 'pt-2')
        // The mark sits in a 48px slot: its center is the icon column (x = 24).
        const slot = within(header).getByTestId('rail-header-mark-slot')
        expect(slot).toHaveClass('w-12', 'justify-center')
        expect(within(slot).getByTestId('shell-brand-mark')).toBeInTheDocument()

        const toggles = screen.getAllByRole('button', { name: 'Expand or collapse projects' })
        expect(toggles).toHaveLength(1)
        expect(toggles[0]).toHaveAttribute('aria-pressed', 'true')
        expect(toggles[0]).toHaveAttribute('data-testid', 'rail-toggle')
        expect(toggles[0]).toHaveClass('size-7')
        // The toggle is the header's only and last control.
        const headerButtons = within(header).getAllByRole('button')
        expect(headerButtons).toEqual([toggles[0]])
        expect(header.lastElementChild).toBe(toggles[0])
        unmount()
      }
    })

    it('keeps the Troupe mark after the traffic-light clearance on macOS', () => {
      tauriRef.current = true
      macRef.current = true
      try {
        renderRail()
        const header = screen.getByTestId('rail-header')
        const clearance = within(header).getByTestId('traffic-light-clearance')
        expect(clearance.nextElementSibling).toBe(within(header).getByTestId('shell-brand-mark'))
        expect(within(header).queryByTestId('rail-header-mark-slot')).not.toBeInTheDocument()
        expect(header.lastElementChild).toBe(screen.getByTestId('rail-toggle'))
      } finally {
        macRef.current = false
      }
    })

    it('shows the toggle tooltip below the header', async () => {
      renderRail()
      fireEvent.focus(screen.getByRole('button', { name: 'Expand or collapse projects' }))
      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip).toHaveTextContent('Collapse projects')
      expect(tooltip.parentElement).toHaveAttribute('data-side', 'bottom')
    })

    it('has an icon-only footer: Settings and Report a bug at the left, Theme and Shortcuts at the right', () => {
      renderRail()
      const settings = screen.getByRole('button', { name: 'Settings' })
      expect(settings).toHaveClass('size-7')
      expect(settings.textContent).toBe('')
      expect(screen.queryByText('Settings')).not.toBeInTheDocument()

      const footer = settings.parentElement as HTMLElement
      expect(footer).toHaveClass('pl-2.5')
      const names = within(footer)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
      expect(names).toEqual([
        'Settings',
        'Report a bug',
        'Color themes',
        'Open keyboard shortcuts menu'
      ])
      expect(
        within(footer).queryByRole('button', { name: 'Expand or collapse projects' })
      ).toBeNull()
    })

    it('paints the Rail with the sidebar surface and no canvas patches inside', () => {
      renderRail()
      const nav = screen.getByTestId('shell-rail')
      expect(nav).toHaveClass('bg-sidebar', 'group/rail')
      // Scopes the Rail keycap fill (`--rail-keycap` in index.css).
      expect(nav).toHaveAttribute('data-rail-surface')
      expect(nav.querySelector('.bg-background')).toBeNull()
    })

    it('marks the header, mark slot and spacer as drag regions on desktop, never the toggle or web', () => {
      tauriRef.current = true
      const { unmount } = renderRail()
      const header = screen.getByTestId('rail-header')
      expect(header).toHaveAttribute('data-tauri-drag-region')
      expect(within(header).getByTestId('rail-header-mark-slot')).toHaveAttribute(
        'data-tauri-drag-region'
      )
      expect(within(header).getByTestId('rail-toggle')).not.toHaveAttribute(
        'data-tauri-drag-region'
      )
      for (const button of within(header).queryAllByRole('button')) {
        expect(button).not.toHaveAttribute('data-tauri-drag-region')
      }
      unmount()

      tauriRef.current = false
      renderRail()
      expect(document.querySelector('[data-tauri-drag-region]')).toBeNull()
    })

    it('occludes native webviews while the + menu is open', async () => {
      const observer = renderHook(() => useNativeWebviewOccluded())
      renderRail()
      expect(observer.result.current).toBe(false)

      const trigger = screen.getByRole('button', { name: 'Add project or folder group' })
      fireEvent.keyDown(trigger, { key: 'Enter' })
      await screen.findByRole('menuitem', { name: 'New project' })
      expect(observer.result.current).toBe(true)

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
      await waitFor(() => expect(observer.result.current).toBe(false))
    })
  })

  describe('resize', () => {
    it('exposes a separator with the persisted width and resizes by keyboard', () => {
      renderRail()
      const separator = screen.getByRole('separator')
      expect(separator).toHaveAttribute('aria-valuenow', '248')
      expect(separator).toHaveAttribute('aria-valuemin', '180')
      expect(separator).toHaveAttribute('aria-valuemax', '360')

      fireEvent.keyDown(separator, { key: 'ArrowRight' })
      expect(useShellLayoutStore.getState().railWidth).toBe(264)
      expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '264')

      fireEvent.keyDown(separator, { key: 'ArrowLeft' })
      expect(useShellLayoutStore.getState().railWidth).toBe(248)

      fireEvent.keyDown(separator, { key: 'Home' })
      expect(useShellLayoutStore.getState().railWidth).toBe(180)
      fireEvent.keyDown(separator, { key: 'ArrowLeft' })
      expect(useShellLayoutStore.getState().railWidth).toBe(180)

      fireEvent.keyDown(separator, { key: 'End' })
      expect(useShellLayoutStore.getState().railWidth).toBe(360)
      fireEvent.keyDown(separator, { key: 'ArrowRight' })
      expect(useShellLayoutStore.getState().railWidth).toBe(360)
    })

    it('resizes by dragging the handle and stops on mouseup', () => {
      renderRail()
      const separator = screen.getByRole('separator')

      fireEvent.mouseDown(separator, { clientX: 248 })
      fireEvent.mouseMove(document, { clientX: 298 })
      expect(useShellLayoutStore.getState().railWidth).toBe(298)
      expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '298')

      fireEvent.mouseUp(document)
      fireEvent.mouseMove(document, { clientX: 340 })
      expect(useShellLayoutStore.getState().railWidth).toBe(298)
    })

    it('clamps a drag to the store bounds', () => {
      renderRail()
      const separator = screen.getByRole('separator')
      fireEvent.mouseDown(separator, { clientX: 200 })
      fireEvent.mouseMove(document, { clientX: 900 })
      expect(useShellLayoutStore.getState().railWidth).toBe(360)
      fireEvent.mouseMove(document, { clientX: -900 })
      expect(useShellLayoutStore.getState().railWidth).toBe(180)
      fireEvent.mouseUp(document)
    })

    it('has no handle while collapsed', () => {
      useShellLayoutStore.setState({ railExpanded: false })
      renderRail()
      expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    })
  })

  describe('collapsed', () => {
    beforeEach(() => {
      useShellLayoutStore.setState({ railExpanded: false })
    })

    const seedChats = () =>
      useAcpStore.setState({
        sessions: {},
        agentConfigs: [],
        sessionIndex: [
          mockSessionIndexEntry({ id: 'a', title: 'Chat a', projectId: 'p1', cwd: '/repo/alpha' }),
          mockSessionIndexEntry({ id: 'b', title: 'Chat b', projectId: 'p2', cwd: '/repo/beta' })
        ]
      })

    it('is the expanded Rail without labels: nav, Projects, chats, footer, 48px wide', () => {
      seedChats()
      renderRail()
      const nav = screen.getByRole('navigation', { name: 'Projects' })
      expect(screen.getByTestId('shell-rail')).toHaveStyle({ width: '48px' })
      expect(
        within(nav)
          .getAllByRole('button')
          .map((b) => b.getAttribute('aria-label'))
      ).toEqual([
        'New chat',
        'Search',
        'Open canvas',
        'Open automations',
        'Project: Alpha (active)',
        'Chat a',
        'Project: Beta',
        'Settings',
        'Report a bug',
        'Color themes',
        'Open keyboard shortcuts menu'
      ])
      // No label, name or section title is drawn.
      for (const text of ['New chat', 'Search', 'Projects', 'Alpha', 'Beta', 'Chat a']) {
        expect(within(nav).queryByText(text)).not.toBeInTheDocument()
      }
      // The header row stays (same height) but holds no mark and no toggle.
      const header = screen.getByTestId('rail-header')
      expect(header).toHaveClass('h-12')
      expect(header).toBeEmptyDOMElement()
      expect(screen.queryByRole('button', { name: 'Expand or collapse projects' })).toBeNull()
      // SSH is hidden; the old icon stack and tab track are gone.
      expect(within(nav).queryByTestId('ssh-section')).not.toBeInTheDocument()
      expect(within(nav).queryByTestId('rail-column-tab-track')).not.toBeInTheDocument()
      expect(within(nav).queryByRole('button', { name: /Switch project/ })).toBeNull()
      useAcpStore.setState({ sessionIndex: [] })
    })

    it('keeps every row at its expanded height, so each icon keeps its y', () => {
      seedChats()
      const heights = () => ({
        nav: screen.getByRole('button', { name: 'Search' }).className.match(/\bh-7\b/)?.[0],
        project: screen
          .getByRole('button', { name: /^Project: Alpha/ })
          .className.match(/\bh-7\.5\b/)?.[0],
        chat: screen.getByRole('button', { name: 'Chat a' }).className.match(/\bh-7\.5\b/)?.[0],
        header: screen.getByTestId('rail-header').className.match(/\bh-12\b/)?.[0],
        section: screen.getByTestId('rail-section-projects').className.match(/\bh-10\b/)?.[0]
      })
      useShellLayoutStore.setState({ railExpanded: true })
      const expanded = renderRail()
      const open = heights()
      expanded.unmount()

      useShellLayoutStore.setState({ railExpanded: false })
      renderRail()
      expect(heights()).toEqual(open)
      expect(heights()).toEqual({
        nav: 'h-7',
        project: 'h-7.5',
        chat: 'h-7.5',
        header: 'h-12',
        section: 'h-10'
      })
      useAcpStore.setState({ sessionIndex: [] })
    })

    it('turns the Projects header into a 20×1 divider', () => {
      renderRail()
      const section = screen.getByTestId('rail-section-projects')
      expect(section).toHaveClass('h-10', 'pt-3', 'justify-center')
      expect(section.querySelector('[data-rail-section-divider]')).toHaveClass(
        'h-px',
        'w-5',
        'bg-border'
      )
      expect(
        screen.queryByRole('button', { name: 'Add project or folder group' })
      ).not.toBeInTheDocument()
    })

    it('stacks the footer upward with Settings at the bottom', () => {
      renderRail()
      const footer = screen.getByTestId('rail-footer')
      expect(footer).toHaveClass('flex-col-reverse', 'gap-1', 'py-1.5')
      const settings = within(footer).getByRole('button', { name: 'Settings' })
      expect(settings).toHaveClass('size-8')
      // column-reverse: the first child (Settings) is drawn at the bottom.
      expect(footer.firstElementChild).toBe(settings)
    })

    it('shows the nav tooltip with the shortcut keycap at x = 52', async () => {
      renderRail()
      fireEvent.focus(screen.getByRole('button', { name: 'Search' }))
      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip).toHaveTextContent('Search')
      expect(tooltip).toHaveTextContent('Ctrl+K')
    })

    it('opens the command palette, the canvas and Settings from the icons', () => {
      const { props } = renderRail()
      fireEvent.click(screen.getByRole('button', { name: 'Search' }))
      fireEvent.click(screen.getByRole('button', { name: 'Open canvas' }))
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
      expect(props.onOpenCommandPalette).toHaveBeenCalledTimes(1)
      expect(props.onOpenCanvas).toHaveBeenCalledTimes(1)
      expect(useSettingsModalStore.getState().view).toBe('app')
    })

    it('switches project from a project icon', () => {
      const { props } = renderRail()
      fireEvent.click(screen.getByRole('button', { name: 'Project: Beta' }))
      expect(props.onSelectProject).toHaveBeenCalledWith('p2')
    })

    it('opens the project card on hover: the name and the diff stat', async () => {
      useGitStatusStore.setState({
        diffStats: { '/repo/beta': { additions: 12, deletions: 3 } }
      } as never)
      renderRail()
      fireEvent.pointerEnter(screen.getByRole('button', { name: 'Project: Beta' }))
      const card = await screen.findByTestId('rail-project-card')
      expect(card).toHaveTextContent('Beta')
      expect(card).toHaveClass('w-60', 'rounded-[10px]', 'p-1', 'outline-popover-edge')
    })
  })

  describe('expand and collapse', () => {
    it('collapses from the header toggle through the persisted path and logs it', async () => {
      tauriRef.current = false
      renderRail()
      const nav = screen.getByTestId('shell-rail')
      expect(nav).toHaveAttribute('data-expanded', 'true')

      fireEvent.click(screen.getByRole('button', { name: 'Expand or collapse projects' }))
      expect(updatePanelVisibility).toHaveBeenCalledWith('sidebarVisible', false)
      await waitFor(() => expect(nav).toHaveAttribute('data-expanded', 'false'))
      expect(useShellLayoutStore.getState().railExpanded).toBe(false)
      expect(mockLog).toHaveBeenCalledWith({
        level: 'info',
        source: 'Rail',
        message: '[rail] collapse rail (button)'
      })
    })

    it('toasts and logs when the visibility update fails', async () => {
      updatePanelVisibility.mockRejectedValueOnce(new Error('disk full'))
      renderRail()

      fireEvent.click(screen.getByRole('button', { name: 'Expand or collapse projects' }))
      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('disk full'))
      expect(mockLog).toHaveBeenCalledWith({
        level: 'error',
        source: 'Rail',
        message: '[rail] toggle rail failed: disk full'
      })
    })

    it('keeps the worktree reconciler running while collapsed', () => {
      useShellLayoutStore.setState({ railExpanded: false })
      renderRail()
      expect(reconcilerSpy).toHaveBeenCalledWith('p1')
    })

    it('runs the reconciler once for the expanded Rail too', () => {
      renderRail()
      expect(reconcilerSpy).toHaveBeenCalledTimes(1)
      expect(reconcilerSpy).toHaveBeenCalledWith('p1')
    })
  })

  describe('focus return', () => {
    it('returns focus to the Color themes button after the picker closes onto the body', async () => {
      const { rerenderRail } = renderRail({ isThemePickerOpen: true })
      const button = screen.getByRole('button', { name: 'Color themes' })
      expect(button).not.toHaveFocus()

      act(() => rerenderRail({ isThemePickerOpen: false }))
      await waitFor(() => expect(button).toHaveFocus())
    })

    it('leaves focus alone when it moved somewhere else', async () => {
      const { rerenderRail } = renderRail({ isThemePickerOpen: true })
      const search = screen.getByRole('button', { name: 'Search' })
      search.focus()

      act(() => rerenderRail({ isThemePickerOpen: false }))
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      expect(search).toHaveFocus()
    })
  })
})
