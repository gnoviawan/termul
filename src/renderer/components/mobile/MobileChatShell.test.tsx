import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetSheetFocusReturnForTests, sheetCloseAutoFocus } from '@/lib/sheet-focus-return'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import {
  _resetShellAnnouncerForTests,
  useShellAnnouncerStore
} from '@/stores/shell-announcer-store'
import { MobileChatShell } from './MobileChatShell'
import type { MobileShellDrawer } from './MobileShellDrawer'

interface TestTerminal {
  id: string
  name: string
  ptyId?: string
  lastExitCode?: number | null
}

const {
  projectRef,
  extraProjectsRef,
  tauriRef,
  workspaceRef,
  browserTabsRef,
  terminalsRef,
  sessionsRef,
  sessionIndexRef,
  mockAttentionCount,
  mockRequestCloseAgentChat,
  drawerPropsRef,
  drawerModalRef
} = vi.hoisted(() => ({
  // Mutable so individual tests can flip the active project (name, path, git
  // branch) and the shell into web/remote mode (where the project sheet, Files
  // and the web-only ⋯ items are mounted).
  projectRef: {
    current: { id: 'p1', name: 'Demo', path: '/demo' } as
      | { id: string; name: string; path?: string; gitBranch?: string; isGitRepo?: boolean }
      | undefined
  },
  // Other projects in the store besides the active one (cross-project chats).
  extraProjectsRef: {
    current: [] as Array<{
      id: string
      name: string
      path?: string
      gitBranch?: string
      isGitRepo?: boolean
    }>
  },
  tauriRef: { current: true as boolean },
  // Mutable workspace state so tests can seed every tab type whose name the
  // header shows (terminal, editor, git, git-history, browser, chat, canvas).
  workspaceRef: {
    current: {
      leaves: [] as Array<{
        type: 'leaf'
        id: string
        tabs: Array<Record<string, unknown>>
        activeTabId: string | null
      }>,
      activePaneId: 'pane-1',
      fullscreenPaneId: null as string | null,
      removeTab: vi.fn(),
      setActiveTab: vi.fn(),
      clearFullscreenPane: vi.fn()
    }
  },
  browserTabsRef: { current: new Map<string, unknown>() },
  terminalsRef: {
    current: [] as Array<{
      id: string
      name: string
      ptyId?: string
      lastExitCode?: number | null
    }>
  },
  sessionsRef: { current: {} as Record<string, Record<string, unknown>> },
  sessionIndexRef: { current: [] as Array<{ id: string; title: string }> },
  mockAttentionCount: vi.fn(),
  mockRequestCloseAgentChat: vi.fn(),
  // The last props the shell handed to the (stubbed) drawer.
  drawerPropsRef: { current: null as null | ComponentProps<typeof MobileShellDrawer> },
  // Opt-in: render the stubbed drawer as a real modal Radix sheet, for the one
  // test that needs Radix `hideOthers` to run (the shell live region).
  drawerModalRef: { current: false }
}))

vi.mock('@/stores/project-store', () => ({
  useActiveProject: () => projectRef.current,
  useProjectStore: (sel: (s: unknown) => unknown) =>
    sel({
      projects: [...(projectRef.current ? [projectRef.current] : []), ...extraProjectsRef.current],
      activeProjectId: projectRef.current?.id
    })
}))

vi.mock('@/stores/workspace-store', () => ({
  getAllLeafPanes: () => workspaceRef.current.leaves,
  useWorkspaceStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) =>
      sel({
        root: { leaves: workspaceRef.current.leaves },
        activePaneId: workspaceRef.current.activePaneId
      })
    ),
    { getState: () => workspaceRef.current }
  )
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: Object.assign(
    vi.fn((sel: (s: { terminals: TestTerminal[] }) => unknown) =>
      sel({ terminals: terminalsRef.current })
    ),
    { getState: () => ({ terminals: terminalsRef.current }) }
  )
}))

vi.mock('@/stores/browser-session-store', () => ({
  useBrowserSessionStore: (sel: (s: { tabs: Map<string, unknown> }) => unknown) =>
    sel({ tabs: browserTabsRef.current })
}))

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (sel: (s: unknown) => unknown) =>
    sel({ sessions: sessionsRef.current, sessionIndex: sessionIndexRef.current })
}))

// The attention count is covered in use-mobile-attention-count.test.ts; here it
// is a controllable number so the shell test pins only the wiring.
vi.mock('@/hooks/use-mobile-attention-count', () => ({
  useMobileAttentionCount: mockAttentionCount
}))

vi.mock('@/hooks/use-agent-idle-shutdown', () => ({
  requestCloseAgentChat: mockRequestCloseAgentChat
}))

// Stub the drawer so the shell test focuses on the opener wiring and the props
// threaded through (☰ and the pill → drawerOpen → `open`; `onOpenChange` closes
// it). It carries the real drawer's id, so the `aria-controls` of ☰ and the pill
// resolves to an element. The drawer's own layout, focus handling and rows are
// covered in MobileShellDrawer.test.tsx, MobileRecentsList.test.tsx and
// MobileDrawerSectionList.test.tsx.
// With `drawerModalRef` set it wraps the same content in a real modal Sheet.
vi.mock('./MobileShellDrawer', async () => {
  const { Sheet, SheetContent, SheetDescription, SheetTitle } = await import(
    '@/components/ui/sheet'
  )
  return {
    MobileShellDrawer: (props: ComponentProps<typeof MobileShellDrawer>) => {
      drawerPropsRef.current = props
      const content = (
        <>
          <span>shell-drawer</span>
          <button type="button" onClick={() => props.onOpenChange(false)}>
            close-shell-drawer
          </button>
          <button type="button" onClick={props.onOpenProjects}>
            stub-open-projects
          </button>
        </>
      )
      if (drawerModalRef.current) {
        return (
          <Sheet open={props.open} onOpenChange={props.onOpenChange}>
            <SheetContent side="left" id="mobile-shell-drawer">
              <SheetTitle>Chats</SheetTitle>
              <SheetDescription className="sr-only">Stub drawer</SheetDescription>
              {content}
            </SheetContent>
          </Sheet>
        )
      }
      return props.open ? <div id="mobile-shell-drawer">{content}</div> : null
    }
  }
})

// Stub the project sheet so the shell test focuses on the trigger wiring
// (subtitle → projectsOpen → sheet `open` prop → onOpenChange close) and on the
// props the shell passes. The sheet's own rows, states and focus handling are
// covered in ProjectSwitcherDrawer.test.tsx. Like Radix, the stub fires
// `onCloseAutoFocus` once it has closed.
vi.mock('@/components/chat/ProjectSwitcherDrawer', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    ProjectSwitcherDrawer: ({
      open,
      onOpenChange,
      onAddProject,
      side,
      id,
      onCloseAutoFocus
    }: {
      open: boolean
      onOpenChange: (open: boolean) => void
      onAddProject?: () => void
      side?: string
      id?: string
      onCloseAutoFocus?: (event: Event) => void
    }) => {
      const wasOpen = useRef(false)
      useEffect(() => {
        if (wasOpen.current && !open) {
          onCloseAutoFocus?.(new Event('focusout', { cancelable: true }))
        }
        wasOpen.current = open
      }, [open, onCloseAutoFocus])
      return open ? (
        <div data-testid="project-sheet" data-side={side} id={id}>
          <span>project-drawer</span>
          <button type="button" onClick={() => onOpenChange(false)}>
            close-drawer
          </button>
          {onAddProject && (
            <button
              type="button"
              onClick={() => {
                onOpenChange(false)
                onAddProject()
              }}
            >
              add-project
            </button>
          )}
        </div>
      ) : null
    }
  }
})

// Stub the file-explorer drawer so the shell test focuses on the trigger
// wiring (button → filesOpen → drawer `open` prop → onOpenChange close).
// The drawer's own open/close + file-management is covered in
// MobileFileExplorer.test.tsx. "open-file" mirrors a successful file open:
// `onFileOpened` first, then the close.
vi.mock('./MobileFileExplorer', () => ({
  MobileFileExplorer: ({
    open,
    onOpenChange,
    onFileOpened
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onFileOpened?: () => void
  }) =>
    open ? (
      <div>
        <span>files-drawer</span>
        <button type="button" onClick={() => onOpenChange(false)}>
          close-files
        </button>
        <button
          type="button"
          onClick={() => {
            onFileOpened?.()
            onOpenChange(false)
          }}
        >
          open-file
        </button>
      </div>
    ) : null
}))

// The real hook subscribes to the acp and connection stores, and this file
// mocks `@/stores/acp-store` with a selector-only stub (no `subscribe`). Keep
// the part the shell render needs, registering the live region so `announce`
// works, and leave the subscriptions to use-shell-announcements.test.tsx.
vi.mock('@/hooks/use-shell-announcements', async () => {
  const { useEffect } = await import('react')
  const { useShellAnnouncerStore } = await import('@/stores/shell-announcer-store')
  return {
    useShellAnnouncements: () => {
      useEffect(() => useShellAnnouncerStore.getState().registerRegion(), [])
    }
  }
})

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => tauriRef.current
}))

type ShellProps = ComponentProps<typeof MobileChatShell>

function renderShell(props: Partial<ShellProps> = {}) {
  return render(
    <MemoryRouter>
      <MobileChatShell onNewChat={vi.fn()} canNewChat {...props}>
        <div>chat body</div>
      </MobileChatShell>
    </MemoryRouter>
  )
}

/** Re-renders the shell so it re-reads the mutable workspace and store refs. */
function rerenderShell(
  view: ReturnType<typeof renderShell>,
  props: Partial<ShellProps> = {}
): void {
  view.rerender(
    <MemoryRouter>
      <MobileChatShell onNewChat={vi.fn()} canNewChat {...props}>
        <div>chat body</div>
      </MobileChatShell>
    </MemoryRouter>
  )
}

function seedTabs(tabs: Array<Record<string, unknown>>, activeTabId: string | null): void {
  workspaceRef.current = {
    ...workspaceRef.current,
    leaves: [{ type: 'leaf', id: 'pane-1', tabs, activeTabId }],
    activePaneId: 'pane-1'
  }
}

function drawerProps(): ComponentProps<typeof MobileShellDrawer> {
  if (!drawerPropsRef.current) throw new Error('drawer stub never rendered')
  return drawerPropsRef.current
}

function seedActiveTerminal(terminal: Partial<TestTerminal> = {}): void {
  seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }], 'term-t1')
  terminalsRef.current = [{ id: 't1', name: 'zsh — dev server', ...terminal }]
}

const NARROW_QUERY = '(max-width: 360px)'
const originalMatchMedia = window.matchMedia

function stubNarrowViewport(narrow: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query === NARROW_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia
}

function overlayIds(): string[] {
  return useOverlayStackStore.getState().stack.map((entry) => entry.id)
}

async function openHeaderSheet(): Promise<HTMLElement> {
  fireEvent.click(screen.getByLabelText('More'))
  return await screen.findByRole('dialog')
}

describe('MobileChatShell', () => {
  beforeEach(() => {
    _resetShellAnnouncerForTests()
    _resetSheetFocusReturnForTests()
    drawerModalRef.current = false
    mockAttentionCount.mockReset()
    mockAttentionCount.mockReturnValue(0)
    mockRequestCloseAgentChat.mockReset()
    mockRequestCloseAgentChat.mockImplementation((_sessionId: string, closeTab: () => void) =>
      closeTab()
    )
    workspaceRef.current.removeTab.mockReset()
    workspaceRef.current.setActiveTab.mockReset()
    workspaceRef.current.clearFullscreenPane.mockReset()
    workspaceRef.current.fullscreenPaneId = null
    drawerPropsRef.current = null
    tauriRef.current = true
    projectRef.current = { id: 'p1', name: 'Demo', path: '/demo' }
    extraProjectsRef.current = []
    sessionsRef.current = { s1: { title: 'Hello chat' } }
    sessionIndexRef.current = []
    terminalsRef.current = []
    // Default leaf: one agent-chat tab.
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }], 'tab-1')
    browserTabsRef.current = new Map()
    useOverlayStackStore.setState({ stack: [] })
    stubNarrowViewport(false)
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
  })

  describe('header', () => {
    it('holds the ☰, ✎ and ⋯ icon buttons at 44px plus the title and subtitle (no scroller)', () => {
      tauriRef.current = false
      const { container } = renderShell()

      for (const label of ['Open menu', 'New chat', 'More']) {
        const button = screen.getByRole('button', { name: label })
        expect(button.className, label).toContain('size-11')
        expect(button.className, label).not.toContain('size-10')
        expect(button.className, label).not.toMatch(/\bh-10\b/)
        expect(button.className, label).not.toMatch(/\bw-10\b/)
      }
      const header = container.querySelector('header')
      expect(header?.className).toContain('min-h-14')
      expect(header?.querySelector('.overflow-x-auto')).toBeNull()
      expect(screen.getByRole('heading', { level: 1 }).id).toBe('mobile-shell-title')
      // ☰, subtitle, ✎ and ⋯ only (no pill at a zero count).
      expect(header?.querySelectorAll('button')).toHaveLength(4)
      // The controls that moved into the ⋯ sheets are not header buttons.
      for (const label of [
        'Switch project',
        'Browse files',
        'Command palette',
        'New project',
        'Git changes',
        'Restart terminal',
        'Close terminal'
      ]) {
        expect(screen.queryByRole('button', { name: label }), label).not.toBeInTheDocument()
      }
    })

    it('keeps the title block shrinkable so nothing scrolls sideways in the worst case', () => {
      // The Story 11 (QA F9) worst case: web mode, an active terminal, the pill.
      tauriRef.current = false
      seedActiveTerminal()
      mockAttentionCount.mockReturnValue(3)
      const { container } = renderShell({
        onOpenCommandPalette: vi.fn(),
        onOpenGitChanges: vi.fn(),
        onNewProject: vi.fn(),
        onRestartTerminal: vi.fn(),
        onCloseTerminal: vi.fn(),
        onNewTerminal: vi.fn()
      })

      const titleBlock = container.querySelector('[data-mobile-header-title]')
      expect(titleBlock?.className).toContain('min-w-0')
      expect(titleBlock?.className).toContain('flex-1')
      expect(container.querySelector('header .overflow-x-auto')).toBeNull()
      expect(screen.getByLabelText('Terminal actions')).toBeInTheDocument()
    })

    it('renders slim header with title and no desktop chrome markers', () => {
      const { container } = renderShell()

      expect(screen.getByText('Hello chat')).toBeInTheDocument()
      expect(screen.getByText('chat body')).toBeInTheDocument()
      expect(screen.getByLabelText('Open menu')).toBeInTheDocument()
      expect(screen.getByLabelText('New chat')).toBeInTheDocument()
      expect(document.querySelector('[data-mobile-chat-shell]')).toBeTruthy()
      // Header title is a heading for screen-reader landmark navigation.
      expect(container.querySelector('h1')?.textContent).toBe('Hello chat')
      // Desktop chrome (persistent sidebar, activity rail) must not render inside
      // the mobile shell — assert their markers are absent.
      expect(container.querySelector('[data-sidebar]')).toBeNull()
      // The menu button reflects drawer state for assistive tech.
      expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'false')
    })

    describe('title', () => {
      beforeEach(() => {
        browserTabsRef.current = new Map([
          ['b1', { id: 'b1', url: 'https://example.com/page', title: 'Example Site' }]
        ])
      })

      it.each([
        [
          'an unnamed terminal',
          [{ type: 'terminal', id: 'term-t1', terminalId: 't1' }],
          'Terminal'
        ],
        [
          'an editor file (posix path)',
          [{ type: 'editor', id: 'e1', filePath: '/proj/a.ts' }],
          'a.ts'
        ],
        [
          'an editor file (windows path)',
          [{ type: 'editor', id: 'e1', filePath: 'C:\\proj\\b.ts' }],
          'b.ts'
        ],
        ['git changes', [{ type: 'git', id: 'g1', cwd: '/proj' }], 'Git Changes'],
        ['git history', [{ type: 'git-history', id: 'gh1', cwd: '/proj' }], 'Git History'],
        ['a browser tab', [{ type: 'browser', id: 'br1', browserTabId: 'b1' }], 'Example Site'],
        [
          'a canvas tab',
          [{ type: 'canvas', id: 'c1', projectId: 'p1', docPath: '/proj/design.op' }],
          'design.op'
        ],
        [
          'an agent chat with a live title',
          [{ type: 'agent-chat', id: 'a1', sessionId: 's1' }],
          'Hello chat'
        ]
      ])('is the tab name for %s', (_name, tabs, expected) => {
        seedTabs(tabs, tabs[0].id as string)
        renderShell()

        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(expected)
      })

      it('uses the named terminal when the terminal has a name', () => {
        seedActiveTerminal({ name: 'zsh — dev server' })
        renderShell()

        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('zsh — dev server')
      })

      it('falls back to "Terminal" when the terminal name is empty', () => {
        seedActiveTerminal({ name: '' })
        renderShell()

        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Terminal')
      })

      it('falls back from the live chat title to the index title to "Agent Chat"', () => {
        sessionsRef.current = { s1: {} }
        sessionIndexRef.current = [{ id: 's1', title: 'Indexed chat' }]
        const { unmount } = renderShell()
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Indexed chat')
        unmount()

        sessionIndexRef.current = []
        renderShell()
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Agent Chat')
      })

      it('is "Termul" with no active tab', () => {
        seedTabs([], null)
        renderShell()

        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Termul')
      })
    })

    describe('subtitle', () => {
      beforeEach(() => {
        tauriRef.current = false
        projectRef.current = {
          id: 'p1',
          name: 'termul',
          path: '/work',
          gitBranch: 'main',
          isGitRepo: true
        }
      })

      it('worktree chat: project · worktree branch · Worktree', () => {
        sessionsRef.current = {
          s1: {
            title: 'Hello chat',
            projectId: 'p1',
            worktreePath: '/work/.termul/worktrees/ab12',
            worktreeBranch: 'chat/ab12'
          }
        }
        renderShell()

        const subtitle = screen.getByRole('button', { name: 'termul · chat/ab12, switch project' })
        expect(subtitle).toHaveTextContent('termul · chat/ab12 · Worktree')
      })

      it('local chat: the project branch and Local', () => {
        sessionsRef.current = { s1: { title: 'Hello chat', projectId: 'p1' } }
        renderShell()

        expect(
          screen.getByRole('button', { name: 'termul · main, switch project' })
        ).toHaveTextContent('termul · main · Local')
      })

      it('a session that is not loaded uses the active project and no worktree', () => {
        sessionsRef.current = {}
        renderShell()

        expect(
          screen.getByRole('button', { name: 'termul · main, switch project' })
        ).toHaveTextContent('termul · main · Local')
      })

      it("a chat from another project shows that project's name and branch, not the active one's", () => {
        extraProjectsRef.current = [
          { id: 'p2', name: 'other', path: '/other', gitBranch: 'dev', isGitRepo: true }
        ]
        sessionsRef.current = { s1: { title: 'Hello chat', projectId: 'p2' } }
        renderShell()

        expect(
          screen.getByRole('button', { name: 'other · dev, switch project' })
        ).toHaveTextContent('other · dev · Local')
      })

      it.each([
        ['a terminal', () => seedActiveTerminal()],
        ['an editor', () => seedTabs([{ type: 'editor', id: 'e1', filePath: '/a.ts' }], 'e1')],
        ['git changes', () => seedTabs([{ type: 'git', id: 'g1', cwd: '/work' }], 'g1')],
        ['no tab', () => seedTabs([], null)]
      ])('%s shows the active project values, not a chat worktree', (_name, seed) => {
        sessionsRef.current = {
          s1: {
            title: 'Hello chat',
            projectId: 'p1',
            worktreePath: '/work/.termul/worktrees/ab12',
            worktreeBranch: 'chat/ab12'
          }
        }
        seed()
        renderShell()

        expect(
          screen.getByRole('button', { name: 'termul · main, switch project' })
        ).toHaveTextContent('termul · main · Local')
      })

      it('detached HEAD: project · Detached HEAD · Local', () => {
        projectRef.current = { id: 'p1', name: 'termul', path: '/work', isGitRepo: true }
        seedTabs([], null)
        renderShell()

        expect(
          screen.getByRole('button', { name: 'termul · Detached HEAD, switch project' })
        ).toHaveTextContent('termul · Detached HEAD · Local')
      })

      it('worktree with an unknown branch: project · Worktree', () => {
        projectRef.current = { id: 'p1', name: 'termul', path: '/work' }
        sessionsRef.current = {
          s1: {
            title: 'Hello chat',
            projectId: 'p1',
            worktreePath: '/work/.termul/worktrees/ab12'
          }
        }
        renderShell()

        expect(screen.getByRole('button', { name: 'termul, switch project' })).toHaveTextContent(
          'termul · Worktree'
        )
      })

      it('non-git project: the name only', () => {
        projectRef.current = { id: 'p1', name: 'termul', path: '/work', isGitRepo: false }
        renderShell()

        const subtitle = screen.getByRole('button', { name: 'termul, switch project' })
        expect(subtitle).toHaveTextContent(/^termul$/)
      })

      it('no project: "No project", and it still opens the project sheet', async () => {
        projectRef.current = undefined
        renderShell()

        const subtitle = screen.getByRole('button', { name: 'No project, switch project' })
        expect(subtitle).toHaveTextContent('No project')

        fireEvent.click(subtitle)
        expect(await screen.findByText('project-drawer')).toBeInTheDocument()
      })

      it('is plain text, not a button, in the Tauri context', () => {
        tauriRef.current = true
        renderShell()

        expect(screen.getByText('termul · main · Local')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /switch project/ })).not.toBeInTheDocument()
      })
    })

    describe('attention pill and ☰', () => {
      it('counts the active project and the active chat', () => {
        mockAttentionCount.mockReturnValue(2)
        renderShell()

        expect(mockAttentionCount).toHaveBeenCalledWith('p1', 's1')
        expect(screen.getByRole('button', { name: '2 other chats need you' })).toHaveTextContent(
          '2'
        )
      })

      it('passes no chat for a non-chat tab', () => {
        seedActiveTerminal()
        renderShell()

        expect(mockAttentionCount).toHaveBeenCalledWith('p1', null)
      })

      it('is hidden at 0', () => {
        mockAttentionCount.mockReturnValue(0)
        renderShell()

        expect(screen.queryByRole('button', { name: /other chats? needs? you/ })).toBeNull()
      })

      it('the pill and ☰ both open the drawer and report it', async () => {
        mockAttentionCount.mockReturnValue(2)
        const { unmount } = renderShell()

        fireEvent.click(screen.getByRole('button', { name: '2 other chats need you' }))
        expect(await screen.findByText('shell-drawer')).toBeInTheDocument()
        expect(screen.getByLabelText('2 other chats need you')).toHaveAttribute(
          'aria-expanded',
          'true'
        )
        expect(screen.getByLabelText('2 other chats need you')).toHaveAttribute(
          'aria-controls',
          'mobile-shell-drawer'
        )
        expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'true')
        unmount()

        renderShell()
        fireEvent.click(screen.getByLabelText('Open menu'))
        expect(await screen.findByText('shell-drawer')).toBeInTheDocument()
        expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByLabelText('Open menu')).toHaveAttribute(
          'aria-controls',
          'mobile-shell-drawer'
        )
      })

      it('at ≤360px the pill folds into a dot on ☰ with the count in its name', async () => {
        stubNarrowViewport(true)
        mockAttentionCount.mockReturnValue(2)
        renderShell()

        expect(screen.queryByRole('button', { name: /other chats? needs? you/ })).toBeNull()
        const menu = screen.getByRole('button', { name: 'Open menu, 2 chats need you' })
        expect(menu.querySelector('span[aria-hidden="true"]')?.className).toContain('bg-warning')

        fireEvent.click(menu)
        expect(await screen.findByText('shell-drawer')).toBeInTheDocument()
      })
    })

    describe('✎ new slot', () => {
      it('✎ "New chat" calls onNewChat', () => {
        const onNewChat = vi.fn()
        renderShell({ onNewChat })

        fireEvent.click(screen.getByLabelText('New chat'))
        expect(onNewChat).toHaveBeenCalledTimes(1)
      })

      it('is not rendered when a chat cannot be started', () => {
        renderShell({ canNewChat: false })

        expect(screen.queryByLabelText('New chat')).not.toBeInTheDocument()
      })

      it('in a terminal ✎ "New terminal" calls onNewTerminal', () => {
        seedActiveTerminal()
        const onNewTerminal = vi.fn()
        const onNewChat = vi.fn()
        renderShell({ onNewTerminal, onNewChat })

        expect(screen.queryByLabelText('New chat')).not.toBeInTheDocument()
        fireEvent.click(screen.getByLabelText('New terminal'))
        expect(onNewTerminal).toHaveBeenCalledTimes(1)
        expect(onNewChat).not.toHaveBeenCalled()
      })
    })
  })

  describe('header ⋯ sheet', () => {
    function renderWeb(props: Partial<ShellProps> = {}) {
      tauriRef.current = false
      const callbacks = {
        onOpenGitChanges: vi.fn(),
        onOpenCommandPalette: vi.fn(),
        onNewTerminal: vi.fn(),
        onOpenProjectSettings: vi.fn()
      }
      return { ...renderShell({ ...callbacks, ...props }), callbacks }
    }

    function sheetRows(): string[] {
      const sheet = document.getElementById('mobile-header-more-sheet')
      return Array.from(sheet?.querySelectorAll('button') ?? [])
        .map((button) => button.textContent?.trim() ?? '')
        .filter((text) => text.length > 0 && text !== 'Close')
    }

    it('opens from ⋯ with the title and subtitle, and ⋯ reports it', async () => {
      projectRef.current = { id: 'p1', name: 'termul', path: '/work', gitBranch: 'main' }
      renderWeb()

      const more = screen.getByLabelText('More')
      expect(more).toHaveAttribute('aria-haspopup', 'dialog')
      expect(more).toHaveAttribute('aria-expanded', 'false')

      const dialog = await openHeaderSheet()

      expect(dialog.id).toBe('mobile-header-more-sheet')
      expect(dialog).toHaveAccessibleName('Hello chat')
      expect(dialog).toHaveAccessibleDescription('termul · main · Local')
      expect(more).toHaveAttribute('aria-expanded', 'true')
      expect(more).toHaveAttribute('aria-controls', 'mobile-header-more-sheet')
    })

    it('lists Git changes · Files · Command palette · New terminal · Project settings · Close chat', async () => {
      renderWeb()
      await openHeaderSheet()

      expect(sheetRows()).toEqual([
        'Git changes',
        'Files',
        'Command palette',
        'New terminal',
        'Project settings',
        'Close chat'
      ])
      expect(screen.getByRole('button', { name: 'Close chat' }).className).toContain(
        'text-destructive'
      )
    })

    it.each([
      ['Git changes', 'onOpenGitChanges'],
      ['Command palette', 'onOpenCommandPalette'],
      ['New terminal', 'onNewTerminal'],
      ['Project settings', 'onOpenProjectSettings']
    ] as const)('"%s" runs exactly its callback and closes the sheet without focusing ⋯', async (label, key) => {
      const { callbacks } = renderWeb()
      await openHeaderSheet()

      fireEvent.click(screen.getByRole('button', { name: label }))

      expect(callbacks[key]).toHaveBeenCalledTimes(1)
      for (const [name, callback] of Object.entries(callbacks)) {
        if (name !== key) expect(callback, name).not.toHaveBeenCalled()
      }
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      // Focus lands on the destination title, not back on ⋯.
      await waitFor(() =>
        expect(document.activeElement).toBe(document.getElementById('mobile-shell-title'))
      )
      expect(document.activeElement).not.toBe(screen.getByLabelText('More'))
    })

    it('"Files" opens the existing Files sheet', async () => {
      renderWeb()
      await openHeaderSheet()
      expect(screen.queryByText('files-drawer')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Files' }))

      expect(await screen.findByText('files-drawer')).toBeInTheDocument()
      await waitFor(() =>
        expect(document.getElementById('mobile-header-more-sheet')).not.toBeInTheDocument()
      )
    })

    it('"Close chat" closes the active chat through requestCloseAgentChat', async () => {
      renderWeb()
      await openHeaderSheet()

      fireEvent.click(screen.getByRole('button', { name: 'Close chat' }))

      expect(mockRequestCloseAgentChat).toHaveBeenCalledTimes(1)
      expect(mockRequestCloseAgentChat).toHaveBeenCalledWith('s1', expect.any(Function))
      expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('tab-1')
    })

    it('keeps the Tauri gates: no Git changes, Files or Command palette', async () => {
      tauriRef.current = true
      renderShell({
        onOpenGitChanges: vi.fn(),
        onOpenCommandPalette: vi.fn(),
        onNewTerminal: vi.fn(),
        onOpenProjectSettings: vi.fn()
      })
      await openHeaderSheet()

      expect(sheetRows()).toEqual(['New terminal', 'Project settings', 'Close chat'])
    })

    it('omits Git changes when the project has no path', async () => {
      projectRef.current = { id: 'p1', name: 'Demo' }
      renderWeb()
      await openHeaderSheet()
      expect(sheetRows()).toEqual([
        'Files',
        'Command palette',
        'New terminal',
        'Project settings',
        'Close chat'
      ])
    })

    it('omits Project settings when there is no active project', async () => {
      projectRef.current = undefined
      renderWeb()
      await openHeaderSheet()

      expect(screen.queryByRole('button', { name: 'Project settings' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Git changes' })).not.toBeInTheDocument()
    })

    it('omits items whose callback is not threaded', async () => {
      tauriRef.current = false
      renderShell()
      await openHeaderSheet()

      expect(sheetRows()).toEqual(['Files', 'Close chat'])
    })

    it('omits Close chat for a non-chat tab', async () => {
      seedTabs([{ type: 'git', id: 'g1', cwd: '/demo' }], 'g1')
      renderWeb()
      await openHeaderSheet()

      expect(screen.queryByRole('button', { name: 'Close chat' })).not.toBeInTheDocument()
      expect(sheetRows()).toEqual([
        'Git changes',
        'Files',
        'Command palette',
        'New terminal',
        'Project settings',
        'Close tab'
      ])
    })

    it('closes an editor tab through its dirty guard, not removeTab', async () => {
      seedTabs(
        [{ type: 'editor', id: 'edit-/demo/a.ts', filePath: '/demo/a.ts' }],
        'edit-/demo/a.ts'
      )
      const onCloseEditorTab = vi.fn(() => true)
      renderWeb({ onCloseEditorTab })
      await openHeaderSheet()

      fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))

      expect(onCloseEditorTab).toHaveBeenCalledWith('/demo/a.ts')
      expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()
    })

    it('offers Close tab for a Git History tab, through the plain removeTab', async () => {
      seedTabs([{ type: 'git-history', id: 'gh1', cwd: '/demo' }], 'gh1')
      renderWeb()
      await openHeaderSheet()

      fireEvent.click(screen.getByRole('button', { name: 'Close tab' }))

      expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('gh1')
    })

    it('closes when the active tab changes underneath it, and stays closed on return', async () => {
      const view = renderWeb()
      await openHeaderSheet()
      expect(overlayIds()).toContain('header-more-sheet')

      // The active tab becomes a terminal while the sheet is open.
      seedActiveTerminal()
      rerenderShell(view)
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(overlayIds()).not.toContain('header-more-sheet')

      // Coming back to the chat must not resurrect the stale open flag.
      seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }], 'tab-1')
      rerenderShell(view)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByLabelText('More')).toHaveAttribute('aria-expanded', 'false')
    })

    it('registers with and unregisters from the overlay back stack under its id', async () => {
      renderWeb()
      expect(overlayIds()).not.toContain('header-more-sheet')

      await openHeaderSheet()
      expect(overlayIds()).toContain('header-more-sheet')

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(overlayIds()).not.toContain('header-more-sheet'))
    })

    it('hardware back (the registered close) dismisses the sheet', async () => {
      renderWeb()
      await openHeaderSheet()

      act(() => {
        useOverlayStackStore.getState().closeTopmostOverlay()
      })

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('returns focus to ⋯ when dismissed with Escape', async () => {
      renderWeb()
      await openHeaderSheet()

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('More')))
    })

    it('returns focus to ⋯ when dismissed with its close button', async () => {
      renderWeb()
      await openHeaderSheet()

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('More')))
    })
  })

  describe('terminal ⋯ sheet', () => {
    function renderTerminal(props: Partial<ShellProps> = {}) {
      const callbacks = {
        onRenameTerminal: vi.fn(),
        onRestartTerminal: vi.fn(),
        onOpenCommandHistory: vi.fn(),
        onCloseTerminal: vi.fn()
      }
      return { ...renderShell({ ...callbacks, ...props }), callbacks }
    }

    async function openTerminalSheet(): Promise<HTMLElement> {
      fireEvent.click(screen.getByLabelText('Terminal actions'))
      return await screen.findByRole('dialog')
    }

    it('opens from ⋯ "Terminal actions" and ⋯ reports it', async () => {
      seedActiveTerminal({ lastExitCode: 127 })
      renderTerminal()

      const more = screen.getByLabelText('Terminal actions')
      expect(more).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByLabelText('More')).not.toBeInTheDocument()

      const dialog = await openTerminalSheet()

      expect(dialog.id).toBe('mobile-terminal-actions-sheet')
      expect(dialog).toHaveAccessibleName('zsh — dev server')
      expect(dialog).toHaveAccessibleDescription('Last exit code 127')
      expect(more).toHaveAttribute('aria-expanded', 'true')
      expect(more).toHaveAttribute('aria-controls', 'mobile-terminal-actions-sheet')
    })

    it('omits the exit code until a command has exited', async () => {
      seedActiveTerminal({ lastExitCode: null })
      renderTerminal()
      await openTerminalSheet()

      expect(screen.queryByText(/Last exit code/)).not.toBeInTheDocument()
    })

    it('Restart terminal calls onRestartTerminal(terminalId) and closes', async () => {
      seedActiveTerminal()
      const { callbacks } = renderTerminal()
      await openTerminalSheet()

      fireEvent.click(screen.getByRole('button', { name: 'Restart terminal' }))

      expect(callbacks.onRestartTerminal).toHaveBeenCalledTimes(1)
      expect(callbacks.onRestartTerminal).toHaveBeenCalledWith('t1')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('focuses the header title, not ⋯, after a row was chosen', async () => {
      seedActiveTerminal()
      renderTerminal()
      await openTerminalSheet()

      fireEvent.click(screen.getByRole('button', { name: 'Restart terminal' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() =>
        expect(document.activeElement).toBe(document.getElementById('mobile-shell-title'))
      )
      expect(document.activeElement).not.toBe(screen.getByLabelText('Terminal actions'))
    })

    it('Command history calls onOpenCommandHistory() and closes', async () => {
      seedActiveTerminal()
      const { callbacks } = renderTerminal()
      await openTerminalSheet()

      fireEvent.click(screen.getByRole('button', { name: 'Command history' }))

      expect(callbacks.onOpenCommandHistory).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('Close terminal calls onCloseTerminal(terminalId, tabId) and closes', async () => {
      seedActiveTerminal()
      const { callbacks } = renderTerminal()
      await openTerminalSheet()

      fireEvent.click(screen.getByRole('button', { name: 'Close terminal' }))

      expect(callbacks.onCloseTerminal).toHaveBeenCalledTimes(1)
      expect(callbacks.onCloseTerminal).toHaveBeenCalledWith('t1', 'term-t1')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('renames the terminal in place and returns focus to ⋯', async () => {
      seedActiveTerminal()
      const { callbacks } = renderTerminal()
      await openTerminalSheet()

      fireEvent.click(screen.getByRole('button', { name: 'Rename terminal' }))
      const input = screen.getByRole('textbox', { name: 'Rename zsh — dev server' })
      fireEvent.change(input, { target: { value: '  api  ' } })
      fireEvent.keyDown(input, { key: 'Enter' })

      expect(callbacks.onRenameTerminal).toHaveBeenCalledWith('t1', 'api')
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByLabelText('Terminal actions'))
      )
    })

    describe('navigation rows (web mode)', () => {
      function renderWebTerminal(props: Partial<ShellProps> = {}) {
        tauriRef.current = false
        seedActiveTerminal()
        const navigation = {
          onOpenGitChanges: vi.fn(),
          onOpenCommandPalette: vi.fn(),
          onOpenProjectSettings: vi.fn()
        }
        const view = renderTerminal({ ...navigation, ...props })
        return { ...view, navigation }
      }

      function terminalSheetRows(): string[] {
        const sheet = document.getElementById('mobile-terminal-actions-sheet')
        return Array.from(sheet?.querySelectorAll('button') ?? [])
          .map((button) => button.textContent?.trim() ?? '')
          .filter((text) => text.length > 0 && text !== 'Close')
      }

      function closeEvent(): Event {
        return new Event('focusScope.autoFocusOnUnmount', { cancelable: true })
      }

      /** Lets the terminal sheet hand focus to the title, then drops it to `<body>`. */
      async function settleAfterTerminalSheetCloses(): Promise<void> {
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        await waitFor(() =>
          expect(document.activeElement).toBe(document.getElementById('mobile-shell-title'))
        )
        act(() => {
          ;(document.activeElement as HTMLElement | null)?.blur()
        })
        expect(document.activeElement).toBe(document.body)
      }

      it('lists the header sheet rows after Command history and before Close terminal', async () => {
        renderWebTerminal()
        await openTerminalSheet()

        expect(terminalSheetRows()).toEqual([
          'Rename terminal',
          'Restart terminal',
          'Command history',
          'Git changes',
          'Files',
          'Command palette',
          'Project settings',
          'Close terminal'
        ])
        expect(screen.getByRole('button', { name: 'Close terminal' }).className).toContain(
          'text-destructive'
        )
      })

      it('has no New terminal row even when the shell can create one', async () => {
        renderWebTerminal({ onNewTerminal: vi.fn() })
        await openTerminalSheet()

        expect(screen.queryByRole('button', { name: 'New terminal' })).not.toBeInTheDocument()
        // The header pencil is New terminal in a terminal.
        expect(screen.getByLabelText('New terminal')).toBeInTheDocument()
      })

      it.each([
        ['Git changes', 'onOpenGitChanges'],
        ['Command palette', 'onOpenCommandPalette'],
        ['Project settings', 'onOpenProjectSettings']
      ] as const)('"%s" runs exactly its callback once, closes and focuses the title', async (label, key) => {
        const { navigation, callbacks } = renderWebTerminal()
        await openTerminalSheet()

        fireEvent.click(screen.getByRole('button', { name: label }))

        expect(navigation[key]).toHaveBeenCalledTimes(1)
        for (const [name, callback] of Object.entries(navigation)) {
          if (name !== key) expect(callback, name).not.toHaveBeenCalled()
        }
        expect(callbacks.onRestartTerminal).not.toHaveBeenCalled()
        expect(callbacks.onCloseTerminal).not.toHaveBeenCalled()
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        // The destination changed, so focus lands on the title, not the more button.
        await waitFor(() =>
          expect(document.activeElement).toBe(document.getElementById('mobile-shell-title'))
        )
      })

      it('"Files" opens the existing Files sheet and closes the terminal sheet', async () => {
        renderWebTerminal()
        await openTerminalSheet()
        expect(screen.queryByText('files-drawer')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Files' }))

        expect(await screen.findByText('files-drawer')).toBeInTheDocument()
        await waitFor(() =>
          expect(document.getElementById('mobile-terminal-actions-sheet')).not.toBeInTheDocument()
        )
      })

      it('records the more button as the Git sheet opener and still opens it', async () => {
        const { navigation } = renderWebTerminal()
        const more = screen.getByLabelText('Terminal actions')
        await openTerminalSheet()
        fireEvent.click(screen.getByRole('button', { name: 'Git changes' }))

        expect(navigation.onOpenGitChanges).toHaveBeenCalledTimes(1)
        await settleAfterTerminalSheetCloses()
        sheetCloseAutoFocus('git-sheet')(closeEvent())

        expect(document.activeElement).toBe(more)
      })

      it('records the more button as the Files sheet opener', async () => {
        renderWebTerminal()
        const more = screen.getByLabelText('Terminal actions')
        await openTerminalSheet()
        fireEvent.click(screen.getByRole('button', { name: 'Files' }))
        expect(await screen.findByText('files-drawer')).toBeInTheDocument()
        await settleAfterTerminalSheetCloses()

        const event = closeEvent()
        sheetCloseAutoFocus('files-sheet')(event)

        expect(event.defaultPrevented).toBe(true)
        expect(document.activeElement).toBe(more)
      })

      it('keeps the Tauri gates: no Git changes, Files or Command palette, but Project settings', async () => {
        tauriRef.current = true
        seedActiveTerminal()
        renderTerminal({
          onOpenGitChanges: vi.fn(),
          onOpenCommandPalette: vi.fn(),
          onOpenProjectSettings: vi.fn()
        })
        await openTerminalSheet()

        expect(terminalSheetRows()).toEqual([
          'Rename terminal',
          'Restart terminal',
          'Command history',
          'Project settings',
          'Close terminal'
        ])
      })

      it('omits Git changes when the project has no path', async () => {
        projectRef.current = { id: 'p1', name: 'Demo' }
        renderWebTerminal()
        await openTerminalSheet()

        expect(terminalSheetRows()).toEqual([
          'Rename terminal',
          'Restart terminal',
          'Command history',
          'Files',
          'Command palette',
          'Project settings',
          'Close terminal'
        ])
      })

      it('omits Project settings when there is no active project', async () => {
        projectRef.current = undefined
        renderWebTerminal()
        await openTerminalSheet()

        expect(screen.queryByRole('button', { name: 'Project settings' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Git changes' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument()
      })

      it('omits rows whose callback is not threaded', async () => {
        tauriRef.current = false
        seedActiveTerminal()
        renderTerminal()
        await openTerminalSheet()

        expect(terminalSheetRows()).toEqual([
          'Rename terminal',
          'Restart terminal',
          'Command history',
          'Files',
          'Close terminal'
        ])
      })

      it('offers the same navigation rows as the header sheet does for a chat', async () => {
        const view = renderWebTerminal()
        await openTerminalSheet()
        const navigationLabels = ['Git changes', 'Files', 'Command palette', 'Project settings']
        const fromTerminal = terminalSheetRows().filter((row) => navigationLabels.includes(row))
        fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

        seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }], 'tab-1')
        rerenderShell(view, {
          onOpenGitChanges: view.navigation.onOpenGitChanges,
          onOpenCommandPalette: view.navigation.onOpenCommandPalette,
          onOpenProjectSettings: view.navigation.onOpenProjectSettings
        })
        await openHeaderSheet()
        const fromHeader = Array.from(
          document.getElementById('mobile-header-more-sheet')?.querySelectorAll('button') ?? []
        )
          .map((button) => button.textContent?.trim() ?? '')
          .filter((text) => navigationLabels.includes(text))

        expect(fromTerminal).toEqual(navigationLabels)
        expect(fromHeader).toEqual(fromTerminal)
      })
    })

    it('titles the sheet "Terminal" when the terminal name is empty', async () => {
      seedActiveTerminal({ name: '' })
      renderTerminal()

      expect(await openTerminalSheet()).toHaveAccessibleName('Terminal')
    })

    it('closes when the active terminal changes underneath it', async () => {
      const twoTerminals = [
        { type: 'terminal', id: 'term-t1', terminalId: 't1' },
        { type: 'terminal', id: 'term-t2', terminalId: 't2' }
      ]
      seedTabs(twoTerminals, 'term-t1')
      terminalsRef.current = [
        { id: 't1', name: 'one' },
        { id: 't2', name: 'two' }
      ]
      const view = renderTerminal()
      expect(await openTerminalSheet()).toHaveAccessibleName('one')

      // Another terminal becomes active: the open sheet must not retarget it.
      seedTabs(twoTerminals, 'term-t2')
      rerenderShell(view)

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(overlayIds()).not.toContain('terminal-actions-sheet')
      expect(screen.getByLabelText('Terminal actions')).toHaveAttribute('aria-expanded', 'false')
    })

    it('registers with and unregisters from the overlay back stack under its id', async () => {
      seedActiveTerminal()
      renderTerminal()
      expect(overlayIds()).not.toContain('terminal-actions-sheet')

      await openTerminalSheet()
      expect(overlayIds()).toContain('terminal-actions-sheet')

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(overlayIds()).not.toContain('terminal-actions-sheet'))
    })

    it('returns focus to ⋯ when dismissed with Escape', async () => {
      seedActiveTerminal()
      renderTerminal()
      await openTerminalSheet()

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByLabelText('Terminal actions'))
      )
    })

    it('returns focus to ⋯ when dismissed with its close button', async () => {
      seedActiveTerminal()
      renderTerminal()
      await openTerminalSheet()

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByLabelText('Terminal actions'))
      )
    })

    it('never opens without an active terminal tab, even when left open earlier', async () => {
      seedActiveTerminal()
      const view = renderTerminal()
      await openTerminalSheet()
      expect(overlayIds()).toContain('terminal-actions-sheet')

      // The active tab becomes a chat while the sheet is open.
      seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }], 'tab-1')
      view.rerender(
        <MemoryRouter>
          <MobileChatShell onNewChat={vi.fn()} canNewChat>
            <div>chat body</div>
          </MobileChatShell>
        </MemoryRouter>
      )
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(overlayIds()).not.toContain('terminal-actions-sheet')

      // A terminal tab coming back must not resurrect the stale open flag.
      seedActiveTerminal()
      view.rerender(
        <MemoryRouter>
          <MobileChatShell onNewChat={vi.fn()} canNewChat>
            <div>chat body</div>
          </MobileChatShell>
        </MemoryRouter>
      )
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByLabelText('Terminal actions')).toHaveAttribute('aria-expanded', 'false')
    })
  })

  describe('project sheet', () => {
    it('opens from the subtitle as a bottom sheet with its own id', async () => {
      tauriRef.current = false
      renderShell()

      const subtitle = screen.getByRole('button', { name: /switch project/ })
      expect(subtitle).toHaveAttribute('aria-expanded', 'false')
      // Drawer starts closed.
      expect(screen.queryByText('project-drawer')).not.toBeInTheDocument()

      fireEvent.click(subtitle)

      const sheet = await screen.findByTestId('project-sheet')
      expect(sheet).toHaveAttribute('data-side', 'bottom')
      expect(sheet.id).toBe('mobile-project-sheet')
      expect(subtitle).toHaveAttribute('aria-expanded', 'true')
      expect(subtitle).toHaveAttribute('aria-controls', 'mobile-project-sheet')
      expect(overlayIds()).toContain('projects-sheet')
    })

    it('closing via onOpenChange(false) unmounts it and returns focus to the subtitle', async () => {
      tauriRef.current = false
      renderShell()
      const subtitle = screen.getByRole('button', { name: /switch project/ })
      fireEvent.click(subtitle)
      expect(await screen.findByText('project-drawer')).toBeInTheDocument()

      fireEvent.click(screen.getByText('close-drawer'))

      expect(screen.queryByText('project-drawer')).not.toBeInTheDocument()
      await waitFor(() => expect(document.activeElement).toBe(subtitle))
    })

    it('returns focus to the subtitle when it was opened from the drawer project row', async () => {
      tauriRef.current = false
      renderShell()
      const subtitle = screen.getByRole('button', { name: /switch project/ })
      fireEvent.click(screen.getByLabelText('Open menu'))
      fireEvent.click(screen.getByText('stub-open-projects'))
      expect(await screen.findByText('project-drawer')).toBeInTheDocument()

      fireEvent.click(screen.getByText('close-drawer'))

      expect(screen.queryByText('project-drawer')).not.toBeInTheDocument()
      await waitFor(() => expect(document.activeElement).toBe(subtitle))
    })

    it('hands onNewProject to the sheet as its Add project action', async () => {
      tauriRef.current = false
      const onNewProject = vi.fn()
      renderShell({ onNewProject })

      fireEvent.click(screen.getByRole('button', { name: /switch project/ }))
      fireEvent.click(await screen.findByText('add-project'))

      expect(onNewProject).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId('project-sheet')).not.toBeInTheDocument()
    })

    it('offers no Add project action when onNewProject is not threaded', async () => {
      tauriRef.current = false
      renderShell()

      fireEvent.click(screen.getByRole('button', { name: /switch project/ }))

      expect(await screen.findByTestId('project-sheet')).toBeInTheDocument()
      expect(screen.queryByText('add-project')).not.toBeInTheDocument()
    })

    it('does not mount the project sheet in Tauri (desktop) mode', () => {
      tauriRef.current = true
      renderShell()

      expect(screen.queryByRole('button', { name: /switch project/ })).not.toBeInTheDocument()
      expect(screen.queryByTestId('project-sheet')).not.toBeInTheDocument()
    })
  })

  describe('Files, palette and Git changes (web mode only)', () => {
    it('Files toggles the Files sheet open and closed', async () => {
      tauriRef.current = false
      renderShell()
      await openHeaderSheet()
      expect(screen.queryByText('files-drawer')).not.toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: 'Files' }))
      expect(await screen.findByText('files-drawer')).toBeInTheDocument()

      // Closing via the sheet's onOpenChange(false) unmounts its content.
      fireEvent.click(screen.getByText('close-files'))
      expect(screen.queryByText('files-drawer')).not.toBeInTheDocument()
    })

    it('Files is not offered in Tauri (desktop) mode', async () => {
      tauriRef.current = true
      renderShell()
      await openHeaderSheet()

      // Desktop never mounts the web/remote file explorer — the right-sidebar
      // FileExplorer owns file browsing there.
      expect(screen.queryByRole('button', { name: 'Files' })).not.toBeInTheDocument()
    })

    it('Command palette is not offered in Tauri (desktop) mode', async () => {
      tauriRef.current = true
      renderShell({ onOpenCommandPalette: vi.fn() })
      await openHeaderSheet()

      expect(screen.queryByRole('button', { name: 'Command palette' })).not.toBeInTheDocument()
    })

    it('Command palette invokes onOpenCommandPalette in web mode', async () => {
      tauriRef.current = false
      const onOpenCommandPalette = vi.fn()
      renderShell({ onOpenCommandPalette })
      await openHeaderSheet()

      fireEvent.click(screen.getByRole('button', { name: 'Command palette' }))
      expect(onOpenCommandPalette).toHaveBeenCalledTimes(1)
    })

    it('Git changes is not offered in Tauri (desktop) mode', async () => {
      tauriRef.current = true
      renderShell({ onOpenGitChanges: vi.fn() })
      await openHeaderSheet()

      expect(screen.queryByRole('button', { name: 'Git changes' })).not.toBeInTheDocument()
    })

    it('Git changes invokes onOpenGitChanges in web mode', async () => {
      tauriRef.current = false
      const onOpenGitChanges = vi.fn()
      renderShell({ onOpenGitChanges })
      await openHeaderSheet()

      fireEvent.click(screen.getByRole('button', { name: 'Git changes' }))
      expect(onOpenGitChanges).toHaveBeenCalledTimes(1)
    })

    it('Git changes is omitted when the active project has no path', async () => {
      tauriRef.current = false
      projectRef.current = { id: 'p1', name: 'Demo' }
      renderShell({ onOpenGitChanges: vi.fn() })
      await openHeaderSheet()

      expect(screen.queryByRole('button', { name: 'Git changes' })).not.toBeInTheDocument()
    })
  })

  describe('drawer opener', () => {
    it('mounts the drawer closed, with no aria-controls on the opener', () => {
      renderShell()

      const menu = screen.getByLabelText('Open menu')
      expect(drawerProps().open).toBe(false)
      expect(screen.queryByText('shell-drawer')).not.toBeInTheDocument()
      expect(menu).toHaveAttribute('aria-expanded', 'false')
      expect(menu).not.toHaveAttribute('aria-controls')
    })

    it('opens the drawer from ☰ and points aria-controls at #mobile-shell-drawer', () => {
      renderShell()
      const menu = screen.getByLabelText('Open menu')

      fireEvent.click(menu)

      expect(screen.getByText('shell-drawer')).toBeInTheDocument()
      expect(drawerProps().open).toBe(true)
      expect(menu).toHaveAttribute('aria-expanded', 'true')
      expect(menu).toHaveAttribute('aria-controls', 'mobile-shell-drawer')
    })

    it.each([
      ['☰', 0, 'Open menu'],
      ['the attention pill', 2, '2 other chats need you']
    ])('%s: aria-controls resolves to the drawer element', (_name, attentionCount, label) => {
      mockAttentionCount.mockReturnValue(attentionCount)
      renderShell()
      const control = screen.getByRole('button', { name: label })

      fireEvent.click(control)

      const target = document.getElementById(control.getAttribute('aria-controls') ?? '')
      expect(target).not.toBeNull()
      expect(target?.id).toBe('mobile-shell-drawer')
      expect(target).toContainElement(screen.getByText('shell-drawer'))
    })

    it('records ☰ as the opener: dismissing the drawer returns focus to it', () => {
      renderShell()
      const menu = screen.getByLabelText('Open menu')
      fireEvent.click(menu)

      sheetCloseAutoFocus('mobile-drawer')(new Event('focusScope.autoFocusOnUnmount'))

      expect(document.activeElement).toBe(menu)
    })

    it('records the attention pill as the opener when it opened the drawer', () => {
      mockAttentionCount.mockReturnValue(2)
      renderShell()
      const pill = screen.getByRole('button', { name: '2 other chats need you' })
      fireEvent.click(pill)

      sheetCloseAutoFocus('mobile-drawer')(new Event('focusScope.autoFocusOnUnmount'))

      expect(document.activeElement).toBe(pill)
      expect(document.activeElement).not.toBe(screen.getByLabelText('Open menu'))
    })

    it('falls back to ☰ when the pill that opened the drawer is gone', () => {
      mockAttentionCount.mockReturnValue(2)
      const view = renderShell()
      const pill = screen.getByRole('button', { name: '2 other chats need you' })
      fireEvent.click(pill)

      // Nothing needs the user any more, so the pill unmounts behind the drawer.
      mockAttentionCount.mockReturnValue(0)
      rerenderShell(view)
      expect(pill.isConnected).toBe(false)
      sheetCloseAutoFocus('mobile-drawer')(new Event('focusScope.autoFocusOnUnmount'))

      expect(document.activeElement).toBe(screen.getByLabelText('Open menu'))
    })

    it('records the opener again on every open', () => {
      mockAttentionCount.mockReturnValue(2)
      renderShell()
      const menu = screen.getByLabelText('Open menu')
      fireEvent.click(screen.getByRole('button', { name: '2 other chats need you' }))
      fireEvent.click(screen.getByText('close-shell-drawer'))

      fireEvent.click(menu)
      sheetCloseAutoFocus('mobile-drawer')(new Event('focusScope.autoFocusOnUnmount'))

      expect(document.activeElement).toBe(menu)
    })

    it('closes the drawer when it calls onOpenChange(false)', () => {
      renderShell()
      fireEvent.click(screen.getByLabelText('Open menu'))

      fireEvent.click(screen.getByText('close-shell-drawer'))

      expect(screen.queryByText('shell-drawer')).not.toBeInTheDocument()
      expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'false')
      expect(screen.getByLabelText('Open menu')).not.toHaveAttribute('aria-controls')
    })

    it('registers with the overlay back stack while open', () => {
      renderShell()
      expect(overlayIds()).not.toContain('mobile-drawer')

      fireEvent.click(screen.getByLabelText('Open menu'))
      expect(overlayIds()).toContain('mobile-drawer')

      fireEvent.click(screen.getByText('close-shell-drawer'))
      expect(overlayIds()).not.toContain('mobile-drawer')
    })

    it('opens the project sheet from the drawer project row', () => {
      tauriRef.current = false
      renderShell()
      fireEvent.click(screen.getByLabelText('Open menu'))

      fireEvent.click(screen.getByText('stub-open-projects'))

      expect(screen.getByText('project-drawer')).toBeInTheDocument()
    })

    it('threads the active chat and the shell handlers into the drawer', () => {
      const handlers = {
        onNewChat: vi.fn(),
        onNewTerminal: vi.fn(),
        onCloseTerminal: vi.fn(),
        onRenameTerminal: vi.fn(),
        onCloseEditorTab: vi.fn(),
        onOpenGitHistory: vi.fn()
      }
      renderShell(handlers)

      const props = drawerProps()
      expect(props.activeTabId).toBe('tab-1')
      expect(props.activeSessionId).toBe('s1')
      expect(props.canNewChat).toBe(true)
      expect(props.onNewChat).toBe(handlers.onNewChat)
      // New terminal and Git history are wrapped (they also leave /snapshots);
      // the wrappers call the originals.
      props.onNewTerminal?.()
      expect(handlers.onNewTerminal).toHaveBeenCalledTimes(1)
      props.onOpenGitHistory?.()
      expect(handlers.onOpenGitHistory).toHaveBeenCalledTimes(1)
      expect(props.onCloseTerminal).toBe(handlers.onCloseTerminal)
      expect(props.onRenameTerminal).toBe(handlers.onRenameTerminal)
      expect(props.onCloseEditorTab).toBe(handlers.onCloseEditorTab)
      expect(typeof props.onOpenProjects).toBe('function')
    })

    it('has no active chat when a terminal tab is active', () => {
      seedTabs(
        [
          { type: 'terminal', id: 'term-t1', terminalId: 't1' },
          { type: 'agent-chat', id: 'tab-1', sessionId: 's1' }
        ],
        'term-t1'
      )
      renderShell()

      expect(drawerProps().activeTabId).toBe('term-t1')
      expect(drawerProps().activeSessionId).toBeNull()
    })

    it('defaults canNewChat to false', () => {
      renderShell({ canNewChat: undefined })

      expect(drawerProps().canNewChat).toBe(false)
    })
  })

  // ── a11y floor: shell live region ───────────────────────────────────────

  describe('shell live region', () => {
    function liveRegion(): HTMLElement {
      const regions = document.querySelectorAll<HTMLElement>('[data-shell-live-region]')
      expect(regions).toHaveLength(1)
      return regions[0]
    }

    async function announceAndWait(text: string): Promise<void> {
      act(() => {
        useShellAnnouncerStore.getState().announce(text)
      })
      await waitFor(() => expect(liveRegion().textContent).toBe(text))
    }

    it('mounts exactly one empty polite status region as a direct child of the shell root', () => {
      renderShell()
      const region = liveRegion()

      expect(region).toHaveAttribute('role', 'status')
      expect(region).toHaveAttribute('aria-live', 'polite')
      expect(region).toHaveAttribute('aria-atomic', 'true')
      expect(region.classList.contains('sr-only')).toBe(true)
      expect(region.textContent).toBe('')
      expect(region.parentElement).toBe(document.querySelector('[data-mobile-chat-shell]'))
    })

    it('renders the announced text once the delay elapses', async () => {
      renderShell()
      await announceAndWait('Turn finished')
      expect(screen.getByRole('status', { name: '' })).toBe(liveRegion())
    })

    it('keeps the same node through a drawer open and close, outside Radix hideOthers', async () => {
      drawerModalRef.current = true
      renderShell()
      const region = liveRegion()
      await announceAndWait('Turn finished')

      fireEvent.click(screen.getByLabelText('Open menu'))
      expect(await screen.findByText('shell-drawer')).toBeInTheDocument()

      // The modal sheet ran hideOthers: the shell body is aria-hidden now ...
      expect(screen.getByText('chat body').closest('[aria-hidden="true"]')).not.toBeNull()
      // ... but the region is not, and is still the very same node.
      expect(liveRegion()).toBe(region)
      expect(region.closest('[aria-hidden="true"]')).toBeNull()
      expect(region.textContent).toBe('Turn finished')

      // It still announces while the drawer is open.
      await announceAndWait('Approval needed')

      fireEvent.click(screen.getByText('close-shell-drawer'))
      expect(screen.queryByText('shell-drawer')).not.toBeInTheDocument()
      expect(liveRegion()).toBe(region)
      expect(region.textContent).toBe('Approval needed')
    })

    it('is never mounted holding text: a remount starts empty', async () => {
      const { unmount } = renderShell()
      await announceAndWait('Turn finished')

      unmount()
      expect(useShellAnnouncerStore.getState().message).toBe('')

      renderShell()
      expect(liveRegion().textContent).toBe('')
    })

    it('replaces the old message with the newest one', async () => {
      renderShell()
      await announceAndWait('Turn finished')
      await announceAndWait('Approval needed')
      expect(liveRegion().textContent).toBe('Approval needed')
    })
  })

  // ── a11y floor: focus return wiring ─────────────────────────────────────
  //
  // The Files and Git sheets open from the header ⋯ sheet, so ⋯ is the control
  // each one returns focus to. The Files sheet is stubbed (it owns no focus
  // handling in this file) and the Git sheet lives in WorkspaceLayout, so the
  // tests call the same `sheetCloseAutoFocus(id)` handler those sheets pass to
  // `onCloseAutoFocus`.

  describe('focus return wiring', () => {
    function closeEvent(): Event {
      return new Event('focusScope.autoFocusOnUnmount', { cancelable: true })
    }

    /**
     * Lets the ⋯ sheet finish its own close (it hands focus to the title when a
     * row was chosen), then drops focus to `<body>` the way a closing Files or
     * Git sheet leaves it once its content unmounts.
     */
    async function settleAfterMoreSheetCloses(): Promise<void> {
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await waitFor(() =>
        expect(document.activeElement).toBe(document.getElementById('mobile-shell-title'))
      )
      act(() => {
        ;(document.activeElement as HTMLElement | null)?.blur()
      })
      expect(document.activeElement).toBe(document.body)
    }

    it('makes the header title programmatically focusable without a visual change', () => {
      tauriRef.current = false
      renderShell()
      const heading = screen.getByRole('heading', { level: 1 })

      expect(heading).toHaveAttribute('tabindex', '-1')
      // The programmatic focus must not draw the browser's default focus ring.
      expect(heading.className).toContain('focus:outline-none')
      expect(heading.textContent).toBe('Hello chat')
    })

    it('records ⋯ as the files sheet opener', async () => {
      tauriRef.current = false
      renderShell()
      const more = screen.getByLabelText('More')
      await openHeaderSheet()
      fireEvent.click(screen.getByRole('button', { name: 'Files' }))
      expect(await screen.findByText('files-drawer')).toBeInTheDocument()
      await settleAfterMoreSheetCloses()

      const event = closeEvent()
      sheetCloseAutoFocus('files-sheet')(event)

      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(more)
    })

    it('records ⋯ as the git sheet opener and still opens it', async () => {
      tauriRef.current = false
      const onOpenGitChanges = vi.fn()
      renderShell({ onOpenGitChanges })
      const more = screen.getByLabelText('More')
      await openHeaderSheet()
      fireEvent.click(screen.getByRole('button', { name: 'Git changes' }))

      expect(onOpenGitChanges).toHaveBeenCalledTimes(1)
      await settleAfterMoreSheetCloses()
      sheetCloseAutoFocus('git-sheet')(closeEvent())

      expect(document.activeElement).toBe(more)
    })

    it('sends focus to the header title, not ⋯, when a file opened', async () => {
      tauriRef.current = false
      renderShell()
      await openHeaderSheet()
      fireEvent.click(screen.getByRole('button', { name: 'Files' }))
      fireEvent.click(await screen.findByText('open-file'))
      expect(screen.queryByText('files-drawer')).not.toBeInTheDocument()
      await settleAfterMoreSheetCloses()

      sheetCloseAutoFocus('files-sheet')(closeEvent())

      expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
      expect(document.activeElement).not.toBe(screen.getByLabelText('More'))
    })

    it('returns to ⋯ when the files sheet closes without opening a file', async () => {
      tauriRef.current = false
      renderShell()
      const more = screen.getByLabelText('More')
      await openHeaderSheet()
      fireEvent.click(screen.getByRole('button', { name: 'Files' }))
      fireEvent.click(await screen.findByText('close-files'))
      await settleAfterMoreSheetCloses()

      sheetCloseAutoFocus('files-sheet')(closeEvent())

      expect(document.activeElement).toBe(more)
    })
  })

  // ── L-15: entry points that create or activate a tab leave /snapshots ──

  describe('drawer sections', () => {
    it('has no bottom bar on the main screen: header and content only', () => {
      seedActiveTerminal({ ptyId: 'pty-1' })
      renderShell()

      expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
      // The terminal key bar follows the content directly: the bottom edge again.
      const keyBar = screen.getByRole('group', { name: 'Terminal keys' }).parentElement
      expect(screen.getByText('chat body').parentElement?.nextElementSibling).toBe(keyBar)
    })

    it.each([
      ['a chat', [{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }], 'tab-1', 'chats'],
      [
        'a terminal',
        [{ type: 'terminal', id: 'term-t1', terminalId: 't1' }],
        'term-t1',
        'terminals'
      ],
      ['an editor', [{ type: 'editor', id: 'e1', filePath: '/demo/a.ts' }], 'e1', 'editors'],
      ['Git Changes', [{ type: 'git', id: 'g1', cwd: '/demo' }], 'g1', 'editors'],
      ['Git History', [{ type: 'git-history', id: 'gh1', cwd: '/demo' }], 'gh1', null],
      ['no tab', [], null, null]
    ])('preselects the drawer section of %s', (_label, tabs, activeTabId, section) => {
      seedTabs(tabs, activeTabId)
      renderShell()

      expect(drawerProps().section).toBe(section)
    })

    it('hands the drawer the attention count for its Chats badge', () => {
      mockAttentionCount.mockReturnValue(3)
      renderShell()

      expect(drawerProps().attentionCount).toBe(3)
    })

    it('hands the drawer Browse files on web, which opens the Files sheet', () => {
      tauriRef.current = false
      renderShell()

      act(() => drawerProps().onOpenFiles?.())

      expect(screen.getByText('files-drawer')).toBeInTheDocument()
    })
  })

  describe('returning to the workspace route', () => {
    function RouteProbe(): React.JSX.Element {
      return <span data-testid="route">{useLocation().pathname}</span>
    }

    function renderShellAt(path: string, props: Partial<ShellProps> = {}) {
      tauriRef.current = false
      return render(
        <MemoryRouter initialEntries={[path]}>
          <MobileChatShell onNewChat={vi.fn()} canNewChat {...props}>
            <div>chat body</div>
          </MobileChatShell>
          <RouteProbe />
        </MemoryRouter>
      )
    }

    const route = (): string | null => screen.getByTestId('route').textContent

    describe('on /snapshots', () => {
      it('leaves for / after the drawer footer Git history, once the history tab is requested', () => {
        let routeWhenCalled: string | null = null
        const onOpenGitHistory = vi.fn(() => {
          routeWhenCalled = route()
        })
        renderShellAt('/snapshots', { onOpenGitHistory })

        act(() => drawerProps().onOpenGitHistory?.())

        expect(onOpenGitHistory).toHaveBeenCalledTimes(1)
        // The tab is created first, then the route changes.
        expect(routeWhenCalled).toBe('/snapshots')
        expect(route()).toBe('/')
      })

      it('leaves for / after the Terminals New terminal button (the drawer handler)', () => {
        const onNewTerminal = vi.fn()
        renderShellAt('/snapshots', { onNewTerminal })

        act(() => drawerProps().onNewTerminal?.())

        expect(onNewTerminal).toHaveBeenCalledTimes(1)
        expect(route()).toBe('/')
      })

      it('leaves for / after the header ✎ New terminal in a terminal tab', () => {
        seedActiveTerminal()
        const onNewTerminal = vi.fn()
        renderShellAt('/snapshots', { onNewTerminal })

        fireEvent.click(screen.getByLabelText('New terminal'))

        expect(onNewTerminal).toHaveBeenCalledTimes(1)
        expect(route()).toBe('/')
      })

      it('leaves for / after the ⋯ sheet New terminal row', async () => {
        const onNewTerminal = vi.fn()
        renderShellAt('/snapshots', { onNewTerminal })
        await openHeaderSheet()

        fireEvent.click(screen.getByRole('button', { name: 'New terminal' }))

        expect(onNewTerminal).toHaveBeenCalledTimes(1)
        expect(route()).toBe('/')
      })

      it('leaves for / after a file opened from the Files sheet, and still points focus at the title', async () => {
        renderShellAt('/snapshots')
        await openHeaderSheet()
        fireEvent.click(screen.getByRole('button', { name: 'Files' }))

        fireEvent.click(await screen.findByText('open-file'))

        expect(route()).toBe('/')
        expect(screen.queryByText('files-drawer')).not.toBeInTheDocument()
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        act(() => {
          ;(document.activeElement as HTMLElement | null)?.blur()
        })
        sheetCloseAutoFocus('files-sheet')(
          new Event('focusScope.autoFocusOnUnmount', { cancelable: true })
        )
        expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
      })

      it('stays on /snapshots when the Files sheet closes without opening a file', async () => {
        renderShellAt('/snapshots')
        await openHeaderSheet()
        fireEvent.click(screen.getByRole('button', { name: 'Files' }))

        fireEvent.click(await screen.findByText('close-files'))

        expect(route()).toBe('/snapshots')
      })
    })

    describe.each(['/', '/c/s1'])('on the workspace route %s', (path) => {
      it('does not navigate for Git history, New terminal (drawer, ⋯) or an opened file', async () => {
        const onOpenGitHistory = vi.fn()
        const onNewTerminal = vi.fn()
        renderShellAt(path, { onOpenGitHistory, onNewTerminal })

        act(() => drawerProps().onOpenGitHistory?.())
        act(() => drawerProps().onNewTerminal?.())
        await openHeaderSheet()
        fireEvent.click(screen.getByRole('button', { name: 'New terminal' }))
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        await openHeaderSheet()
        fireEvent.click(screen.getByRole('button', { name: 'Files' }))
        fireEvent.click(await screen.findByText('open-file'))

        expect(onOpenGitHistory).toHaveBeenCalledTimes(1)
        expect(onNewTerminal).toHaveBeenCalledTimes(2)
        expect(route()).toBe(path)
      })
    })

    it('keeps a missing handler missing, so the controls stay hidden', async () => {
      renderShellAt('/snapshots')

      expect(drawerProps().onNewTerminal).toBeUndefined()
      expect(drawerProps().onOpenGitHistory).toBeUndefined()
      await openHeaderSheet()
      expect(screen.queryByRole('button', { name: 'New terminal' })).not.toBeInTheDocument()
    })

    it('passes the close handlers through untouched so their return value reaches the drawer', () => {
      const onCloseTerminal = vi.fn(() => true)
      const onCloseEditorTab = vi.fn(() => false)
      renderShellAt('/snapshots', { onCloseTerminal, onCloseEditorTab })

      expect(drawerProps().onCloseTerminal).toBe(onCloseTerminal)
      expect(drawerProps().onCloseEditorTab).toBe(onCloseEditorTab)
      expect(drawerProps().onCloseTerminal?.('t1', 'term-t1')).toBe(true)
      expect(drawerProps().onCloseEditorTab?.('/a.ts')).toBe(false)
      expect(route()).toBe('/snapshots')
    })
  })
})
