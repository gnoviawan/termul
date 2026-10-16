import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as appSettingsHooks from '@/hooks/use-app-settings'
import {
  resetNativeWebviewOcclusionForTests,
  useNativeWebviewOccluded
} from '@/hooks/use-native-webview-occlusion'
import { useGitStatusStore } from '@/stores/git-status-store'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import type { Project } from '@/types/project'
import { ShellRail, type ShellRailProps } from './ShellRail'

const { mockNavigate, mockToastError, tauriRef, macRef, reconcilerSpy } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockToastError: vi.fn(),
  tauriRef: { current: true as boolean },
  macRef: { current: false as boolean },
  reconcilerSpy: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

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
    activeProject: projects[0],
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
    useProjectStore.setState({ projects, groups: [] })
    useGitStatusStore.setState({
      diffStats: {},
      watchDiffStat: vi.fn(() => () => {}),
      refreshDiffStat: vi.fn(() => Promise.resolve())
    })
    vi.spyOn(appSettingsHooks, 'useUpdatePanelVisibility').mockReturnValue(updatePanelVisibility)
  })

  describe('expanded', () => {
    it('is a Projects nav with Search, Canvas, the Projects section, SSH and the footer', () => {
      renderRail()

      const nav = screen.getByRole('navigation', { name: 'Projects' })
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
      // Chats do not nest under projects.
      expect(within(nav).queryByLabelText('Expand chats')).not.toBeInTheDocument()
      // The collapsed-only controls are absent.
      expect(within(nav).queryByRole('button', { name: /Switch project/ })).not.toBeInTheDocument()
      expect(screen.getByTestId('shell-rail')).toHaveStyle({ width: '200px' })
    })

    it('shows the resolved command palette shortcut as a chip on the Search row', () => {
      renderRail()
      expect(within(screen.getByRole('button', { name: 'Search' })).getByText('Ctrl+K')).toBe(
        screen.getByRole('button', { name: 'Search' }).querySelector('kbd')
      )
    })

    it('follows a custom command palette binding', () => {
      const { shortcuts } = useKeyboardShortcutsStore.getState()
      useKeyboardShortcutsStore.setState({
        shortcuts: {
          ...shortcuts,
          commandPalette: { ...shortcuts.commandPalette, customKey: 'ctrl+p' }
        }
      })
      renderRail()
      expect(screen.getByRole('button', { name: 'Search' }).querySelector('kbd')).toHaveTextContent(
        'Ctrl+P'
      )
      useKeyboardShortcutsStore.getState().resetShortcut('commandPalette')
    })

    it('opens the command palette and the canvas from their rows', () => {
      const { props } = renderRail()

      fireEvent.click(screen.getByRole('button', { name: 'Search' }))
      expect(props.onOpenCommandPalette).toHaveBeenCalledTimes(1)

      fireEvent.click(screen.getByRole('button', { name: 'Open canvas' }))
      expect(props.onOpenCanvas).toHaveBeenCalledTimes(1)
    })

    it('disables Canvas with a hint when no project has a path', async () => {
      const { props } = renderRail({ canOpenCanvas: false, activeProject: undefined })
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

    it('ends the Rail header with the one 28px toggle, after the centered Termul mark', () => {
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

    it('keeps the Termul mark after the traffic-light clearance on macOS', () => {
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

    it('has an icon-only footer: Settings at the left, Theme and Shortcuts at the right', () => {
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
      expect(names).toEqual(['Settings', 'Color themes', 'Open keyboard shortcuts menu'])
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
      expect(separator).toHaveAttribute('aria-valuenow', '200')
      expect(separator).toHaveAttribute('aria-valuemin', '180')
      expect(separator).toHaveAttribute('aria-valuemax', '360')

      fireEvent.keyDown(separator, { key: 'ArrowRight' })
      expect(useShellLayoutStore.getState().railWidth).toBe(216)
      expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '216')

      fireEvent.keyDown(separator, { key: 'ArrowLeft' })
      expect(useShellLayoutStore.getState().railWidth).toBe(200)

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

      fireEvent.mouseDown(separator, { clientX: 200 })
      fireEvent.mouseMove(document, { clientX: 250 })
      expect(useShellLayoutStore.getState().railWidth).toBe(250)
      expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '250')

      fireEvent.mouseUp(document)
      fireEvent.mouseMove(document, { clientX: 300 })
      expect(useShellLayoutStore.getState().railWidth).toBe(250)
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

    it('shows only the icons: project stack, Column tabs, Search, Canvas, SSH, Settings', () => {
      renderRail()

      const nav = screen.getByRole('navigation', { name: 'Projects' })
      const names = within(nav)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
      // The Rail toggle shares the top slot with the Termul mark.
      expect(names).toEqual([
        'Expand or collapse projects',
        'Switch project (Alpha)',
        // Other open projects (not archived) follow the active one.
        'Open Beta',
        'Chats',
        'Explorer',
        'Changes',
        'Search',
        'Open canvas',
        'SSH hosts',
        'Settings'
      ])
      expect(within(nav).queryByText('Projects')).not.toBeInTheDocument()
      expect(within(nav).queryByTestId('ssh-section')).not.toBeInTheDocument()
      expect(screen.getByTestId('shell-rail')).toHaveStyle({ width: '48px' })
      // The top band (8px gutter + 40px row) is drag space on desktop.
      // Without traffic lights the mark / toggle swap sits in it.
      const band = screen.getByTestId('rail-top-band')
      expect(band).toHaveClass('h-12', 'pt-2')
      expect(band).toHaveAttribute('data-tauri-drag-region')
      expect(within(band).getByTestId('rail-brand-swap')).toBeInTheDocument()
      // Settings alone is pinned at the bottom.
      const bottom = screen.getByRole('button', { name: 'Settings' }).parentElement as HTMLElement
      expect(bottom).toHaveClass('mt-auto')
      expect(within(bottom).getAllByRole('button')).toHaveLength(1)
    })

    it('puts the mark / toggle swap below the empty top band under the macOS traffic lights', () => {
      tauriRef.current = true
      macRef.current = true
      try {
        renderRail()
        const band = screen.getByTestId('rail-top-band')
        const swap = screen.getByTestId('rail-brand-swap')
        expect(within(band).queryByTestId('rail-brand-swap')).toBeNull()
        expect(band.nextElementSibling).toBe(swap)
        expect(
          within(swap).getByRole('button', { name: 'Expand or collapse projects' })
        ).toBeInTheDocument()
      } finally {
        macRef.current = false
      }
    })

    it('swaps the Termul mark for the toggle in one clipped slot on hover, focus and touch', () => {
      renderRail()
      const swap = screen.getByTestId('rail-brand-swap')
      expect(swap).toHaveClass('size-9', 'overflow-hidden', 'group/swap')
      expect(screen.getByTestId('shell-rail')).toHaveClass('group/rail')

      const mark = screen.getByTestId('rail-brand-swap-mark')
      expect(within(mark).getByTestId('shell-brand-mark')).toBeInTheDocument()
      expect(mark).toHaveClass(
        'group-hover/rail:translate-x-full',
        'group-hover/rail:opacity-0',
        'group-focus-within/swap:translate-x-full',
        'group-focus-within/swap:opacity-0',
        // jsdom cannot evaluate media queries: the pinned-on-no-hover state is
        // covered by asserting these tokens, not by simulating the condition.
        '[@media(any-hover:none)]:pointer-events-none',
        '[@media(any-hover:none)]:opacity-0',
        'duration-[220ms]',
        'motion-reduce:transition-none'
      )

      const toggleSlot = screen.getByTestId('rail-brand-swap-toggle')
      const toggle = within(toggleSlot).getByRole('button', {
        name: 'Expand or collapse projects'
      })
      expect(toggle).toHaveAttribute('aria-pressed', 'false')
      // The slot clips at 36px, so the focus ring is drawn inside.
      expect(toggle).toHaveClass('size-9', 'focus-visible:ring-inset')
      // Rest: off to the left and transparent; shown on hover, focus, touch.
      expect(toggleSlot).toHaveClass(
        '-translate-x-full',
        'opacity-0',
        'group-hover/rail:translate-x-0',
        'group-hover/rail:opacity-100',
        'group-focus-within/swap:translate-x-0',
        'group-focus-within/swap:opacity-100',
        '[@media(any-hover:none)]:translate-x-0',
        '[@media(any-hover:none)]:opacity-100',
        'motion-reduce:transition-none'
      )
    })

    it('names the switcher without a project and keeps Canvas disabled', () => {
      renderRail({ activeProject: undefined, activeProjectId: '', canOpenCanvas: false })
      expect(screen.getByRole('button', { name: 'Switch project' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open canvas' })).toBeDisabled()
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
  })

  describe('expand and collapse', () => {
    it('flips through the persisted path from the header toggle and the collapsed swap toggle', async () => {
      tauriRef.current = false
      renderRail()
      const nav = screen.getByTestId('shell-rail')
      expect(nav).toHaveAttribute('data-expanded', 'true')

      fireEvent.click(screen.getByRole('button', { name: 'Expand or collapse projects' }))
      expect(updatePanelVisibility).toHaveBeenCalledWith('sidebarVisible', false)
      await waitFor(() => expect(nav).toHaveAttribute('data-expanded', 'false'))
      expect(useShellLayoutStore.getState().railExpanded).toBe(false)

      fireEvent.click(screen.getByRole('button', { name: 'Expand or collapse projects' }))
      expect(updatePanelVisibility).toHaveBeenLastCalledWith('sidebarVisible', true)
      await waitFor(() => expect(nav).toHaveAttribute('data-expanded', 'true'))
      expect(useShellLayoutStore.getState().railWidth).toBe(200)
    })

    it('toasts when the visibility update fails', async () => {
      useShellLayoutStore.setState({ railExpanded: false })
      updatePanelVisibility.mockRejectedValueOnce(new Error('disk full'))
      renderRail()

      fireEvent.click(screen.getByRole('button', { name: 'Expand or collapse projects' }))
      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('disk full'))
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

  describe('Project switcher', () => {
    beforeEach(() => {
      useShellLayoutStore.setState({ railExpanded: false })
    })

    async function openSwitcher() {
      const trigger = screen.getByRole('button', { name: 'Switch project (Alpha)' })
      fireEvent.click(trigger)
      const search = await screen.findByRole('textbox', { name: 'Search projects' })
      return { trigger, search }
    }

    it('lists the open projects with paths and marks the active one', async () => {
      renderRail()
      const { search } = await openSwitcher()

      expect(search).toHaveFocus()
      const options = screen.getAllByRole('option')
      expect(options.map((option) => option.textContent)).toEqual([
        expect.stringContaining('Alpha'),
        expect.stringContaining('Beta'),
        'New project'
      ])
      expect(screen.queryByText('Old')).not.toBeInTheDocument()
      expect(within(options[0]).getByText('/repo/alpha')).toBeInTheDocument()
      expect(within(options[0]).getByLabelText('Active project')).toBeInTheDocument()
      expect(within(options[1]).queryByLabelText('Active project')).not.toBeInTheDocument()
    })

    it('filters by name and shows the empty line', async () => {
      renderRail()
      const { search } = await openSwitcher()

      fireEvent.change(search, { target: { value: 'bet' } })
      expect(screen.getByText('Beta')).toBeInTheDocument()
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument()

      fireEvent.change(search, { target: { value: 'zzz' } })
      expect(screen.getByText('No projects found')).toBeInTheDocument()
      // New project stays reachable.
      expect(screen.getByRole('option', { name: 'New project' })).toBeInTheDocument()
    })

    it('Enter switches to the highlighted project, navigates home and closes', async () => {
      const { props } = renderRail()
      const { search } = await openSwitcher()

      fireEvent.change(search, { target: { value: 'bet' } })
      fireEvent.keyDown(search, { key: 'Enter' })

      expect(props.onSelectProject).toHaveBeenCalledWith('p2')
      expect(mockNavigate).toHaveBeenCalledWith('/')
      await waitFor(() =>
        expect(screen.queryByRole('textbox', { name: 'Search projects' })).not.toBeInTheDocument()
      )
    })

    it('arrow keys move the highlight', async () => {
      const { props } = renderRail()
      const { search } = await openSwitcher()

      fireEvent.keyDown(search, { key: 'ArrowDown' })
      fireEvent.keyDown(search, { key: 'Enter' })
      expect(props.onSelectProject).toHaveBeenCalledWith('p2')
    })

    it('clicking a row switches project', async () => {
      const { props } = renderRail()
      await openSwitcher()

      fireEvent.click(screen.getByRole('option', { name: /Beta/ }))
      expect(props.onSelectProject).toHaveBeenCalledWith('p2')
      expect(mockNavigate).toHaveBeenCalledWith('/')
    })

    it('Esc closes the switcher and returns focus to the icon', async () => {
      const { props } = renderRail()
      const { trigger, search } = await openSwitcher()

      fireEvent.keyDown(search, { key: 'Escape' })
      await waitFor(() =>
        expect(screen.queryByRole('textbox', { name: 'Search projects' })).not.toBeInTheDocument()
      )
      await waitFor(() => expect(trigger).toHaveFocus())
      expect(props.onSelectProject).not.toHaveBeenCalled()
    })

    it("New project opens today's dialog and closes", async () => {
      const { props } = renderRail()
      await openSwitcher()

      fireEvent.click(screen.getByRole('option', { name: 'New project' }))
      expect(props.onNewProject).toHaveBeenCalledTimes(1)
      await waitFor(() =>
        expect(screen.queryByRole('textbox', { name: 'Search projects' })).not.toBeInTheDocument()
      )
    })

    it('opens with no active project and keeps New project reachable', async () => {
      const { props } = renderRail({ activeProject: undefined, activeProjectId: '' })
      fireEvent.click(screen.getByRole('button', { name: 'Switch project' }))
      await screen.findByRole('textbox', { name: 'Search projects' })

      expect(screen.queryByLabelText('Active project')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('option', { name: 'New project' }))
      expect(props.onNewProject).toHaveBeenCalledTimes(1)
    })

    it('forgets the query after closing', async () => {
      renderRail()
      const { search, trigger } = await openSwitcher()
      fireEvent.change(search, { target: { value: 'bet' } })
      fireEvent.keyDown(search, { key: 'Escape' })
      await waitFor(() => expect(trigger).toHaveFocus())

      fireEvent.click(trigger)
      expect(await screen.findByRole('textbox', { name: 'Search projects' })).toHaveValue('')
    })

    it('occludes native webviews while open, until it closes', async () => {
      const observer = renderHook(() => useNativeWebviewOccluded())
      renderRail()
      expect(observer.result.current).toBe(false)

      const { search } = await openSwitcher()
      expect(observer.result.current).toBe(true)

      fireEvent.keyDown(search, { key: 'Escape' })
      await waitFor(() => expect(observer.result.current).toBe(false))
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
