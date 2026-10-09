import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { MobileChatShell } from './MobileChatShell'

interface TestTerminal {
  id: string
  name: string
  ptyId?: string
  lastExitCode?: number | null
}

const {
  mockNavigate,
  projectRef,
  extraProjectsRef,
  tauriRef,
  workspaceRef,
  editorRef,
  mockRemoveBrowserTab,
  browserTabsRef,
  terminalsRef,
  sessionsRef,
  sessionIndexRef,
  mockAttentionCount,
  mockRequestCloseAgentChat
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
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
  // Mutable workspace state so Story 6 tests can seed every tab type
  // (terminal, editor, git, git-history, browser) in the drawer.
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
  editorRef: {
    current: {
      openFiles: new Map<string, { isDirty: boolean }>()
    }
  },
  mockRemoveBrowserTab: vi.fn(),
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
  mockRequestCloseAgentChat: vi.fn()
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate
  }
})

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
        activePaneId: workspaceRef.current.activePaneId,
        removeTab: workspaceRef.current.removeTab,
        setActiveTab: workspaceRef.current.setActiveTab
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

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: Object.assign(
    vi.fn((sel: (s: { openFiles: Map<string, { isDirty: boolean }> }) => unknown) =>
      sel({ openFiles: editorRef.current.openFiles })
    ),
    { getState: () => ({ openFiles: editorRef.current.openFiles }) }
  )
}))

vi.mock('@/stores/browser-session-store', () => ({
  useBrowserSessionStore: Object.assign(
    vi.fn((sel: (s: { tabs: Map<string, unknown>; removeTab: unknown }) => unknown) =>
      sel({ tabs: browserTabsRef.current, removeTab: mockRemoveBrowserTab })
    ),
    { getState: () => ({ tabs: browserTabsRef.current, removeTab: mockRemoveBrowserTab }) }
  )
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

vi.mock('@/components/chat/ChatHistoryTab', () => ({
  ChatHistoryTab: ({ onSessionOpened }: { onSessionOpened?: () => void }) => (
    <button type="button" onClick={() => onSessionOpened?.()}>
      Open history chat
    </button>
  )
}))

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
// MobileFileExplorer.test.tsx.
vi.mock('./MobileFileExplorer', () => ({
  MobileFileExplorer: ({
    open,
    onOpenChange
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div>
        <span>files-drawer</span>
        <button type="button" onClick={() => onOpenChange(false)}>
          close-files
        </button>
      </div>
    ) : null
}))

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
    mockNavigate.mockReset()
    mockRemoveBrowserTab.mockReset()
    mockAttentionCount.mockReset()
    mockAttentionCount.mockReturnValue(0)
    mockRequestCloseAgentChat.mockReset()
    mockRequestCloseAgentChat.mockImplementation((_sessionId: string, closeTab: () => void) =>
      closeTab()
    )
    workspaceRef.current.removeTab.mockReset()
    workspaceRef.current.setActiveTab.mockReset()
    workspaceRef.current.clearFullscreenPane.mockReset()
    tauriRef.current = true
    projectRef.current = { id: 'p1', name: 'Demo', path: '/demo' }
    extraProjectsRef.current = []
    sessionsRef.current = { s1: { title: 'Hello chat' } }
    sessionIndexRef.current = []
    terminalsRef.current = []
    // Default leaf: one agent-chat tab (the pre-Story-6 drawer shape).
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }], 'tab-1')
    workspaceRef.current.fullscreenPaneId = null
    editorRef.current.openFiles = new Map()
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
        expect(await screen.findByText('Open history chat')).toBeInTheDocument()
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
        expect(await screen.findByText('Open history chat')).toBeInTheDocument()
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
        expect(await screen.findByText('Open history chat')).toBeInTheDocument()
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
        'Project settings'
      ])
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

  it('opens the chat drawer and closes it after selecting a session', async () => {
    renderShell()

    fireEvent.click(screen.getByLabelText('Open menu'))
    expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText('Open history chat')).toBeInTheDocument()
    expect(screen.getByText('New chat')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Open history chat'))
    expect(screen.queryByText('Open history chat')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'false')
  })

  it('navigates to /snapshots from the drawer', () => {
    tauriRef.current = false
    renderShell()

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByLabelText('Snapshots'))
    expect(mockNavigate).toHaveBeenCalledWith('/snapshots')
    // The drawer closes after navigating.
    expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'false')
  })

  it('hides the Git history button in Tauri (desktop) mode', () => {
    tauriRef.current = true
    renderShell({ onOpenGitHistory: vi.fn() })
    // Desktop never shows the mobile Git History entry (the ActivityRail owns
    // it there). The drawer button must not leak into the mobile shell.
    fireEvent.click(screen.getByLabelText('Open menu'))
    expect(screen.queryByLabelText('Git history')).not.toBeInTheDocument()
  })

  it('mounts the Git history trigger in web mode and invokes onOpenGitHistory', () => {
    tauriRef.current = false
    const onOpenGitHistory = vi.fn()
    renderShell({ onOpenGitHistory })

    fireEvent.click(screen.getByLabelText('Open menu'))
    const btn = screen.getByLabelText('Git history')
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    expect(onOpenGitHistory).toHaveBeenCalledTimes(1)
    // The drawer closes after invoking the handler.
    expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'false')
  })

  it('disables the Git history button when no active project path', () => {
    tauriRef.current = false
    projectRef.current = { id: 'p1', name: 'Demo' }
    renderShell({ onOpenGitHistory: vi.fn() })

    fireEvent.click(screen.getByLabelText('Open menu'))
    expect(screen.getByLabelText('Git history')).toBeDisabled()
  })

  // ── Story 6: drawer lists ALL pane tabs (QA F3 navigation traps) ─────────

  function seedAllTabTypes(): void {
    seedTabs(
      [
        { type: 'terminal', id: 'term-t1', terminalId: 't1' },
        { type: 'editor', id: 'edit-/proj/a.ts', filePath: '/proj/a.ts' },
        { type: 'git', id: 'git-/proj', cwd: '/proj' },
        { type: 'git-history', id: 'git-history-/proj', cwd: '/proj' },
        { type: 'browser', id: 'browser-b1', browserTabId: 'b1' },
        { type: 'agent-chat', id: 'tab-1', sessionId: 's1' }
      ],
      'tab-1'
    )
    browserTabsRef.current = new Map([
      ['b1', { id: 'b1', url: 'https://example.com/page', title: 'Example Site' }]
    ])
  }

  it('drawer lists every non-terminal pane tab with a close affordance', () => {
    seedAllTabTypes()
    renderShell()

    fireEvent.click(screen.getByLabelText('Open menu'))

    // Every tab type is listed in the drawer's Tabs section.
    expect(screen.getByText('a.ts')).toBeInTheDocument()
    expect(screen.getAllByText('Git Changes').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Git History').length).toBeGreaterThan(0)
    expect(screen.getByText('Example Site')).toBeInTheDocument()
    // Editor rows expose a close affordance routed through the dirty guard.
    expect(screen.getByRole('button', { name: 'Close a.ts' })).toBeInTheDocument()
  })

  it('drawer shows the editor dirty dot for dirty files', () => {
    seedAllTabTypes()
    editorRef.current.openFiles = new Map([['/proj/a.ts', { isDirty: true }]])
    renderShell()

    fireEvent.click(screen.getByLabelText('Open menu'))
    expect(screen.getByTestId('editor-dirty-dot')).toBeInTheDocument()
  })

  it('drawer omits the editor dirty dot when the file is clean', () => {
    seedAllTabTypes()
    editorRef.current.openFiles = new Map([['/proj/a.ts', { isDirty: false }]])
    renderShell()

    fireEvent.click(screen.getByLabelText('Open menu'))
    expect(screen.queryByTestId('editor-dirty-dot')).not.toBeInTheDocument()
  })

  it('drawer close on a dirty editor tab routes through the dirty guard, not removeTab', () => {
    seedAllTabTypes()
    const onCloseEditorTab = vi.fn()
    renderShell({ onCloseEditorTab })

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))

    expect(onCloseEditorTab).toHaveBeenCalledWith('/proj/a.ts')
    expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()
  })

  it('drawer close on a terminal tab routes through the existing terminal close flow', () => {
    seedAllTabTypes()
    const onCloseTerminal = vi.fn()
    renderShell({ onCloseTerminal })

    fireEvent.click(screen.getByLabelText('Open menu'))
    // The terminal-store mock has no terminal records, so the row label
    // falls back to the plain "terminal" display name.
    fireEvent.click(screen.getByRole('button', { name: 'Close terminal' }))

    expect(onCloseTerminal).toHaveBeenCalledWith('t1', 'term-t1')
    expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()
  })

  it('drawer close on git and git-history tabs removes the tab directly', () => {
    seedAllTabTypes()
    renderShell()

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByRole('button', { name: 'Close git changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close git history' }))

    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('git-/proj')
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('git-history-/proj')
  })

  it('drawer close on a browser tab tears down the session tab and the workspace tab', () => {
    seedAllTabTypes()
    renderShell()

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByRole('button', { name: 'Close Example Site' }))

    expect(mockRemoveBrowserTab).toHaveBeenCalledWith('b1')
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('browser-b1')
  })

  it('drawer close on an agent-chat tab closes the chat and removes the tab', () => {
    seedAllTabTypes()
    renderShell()

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByRole('button', { name: 'Close Hello chat' }))

    expect(mockRequestCloseAgentChat).toHaveBeenCalledWith('s1', expect.any(Function))
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('tab-1')
  })

  it('drawer close on an editor tab falls back to removeTab when no guard is threaded', () => {
    seedAllTabTypes()
    renderShell()

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))

    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('edit-/proj/a.ts')
  })

  // ── FIX 10: choosing a tab from /snapshots returns to the workspace ──────

  function renderShellAt(path: string): void {
    render(
      <MemoryRouter initialEntries={[path]}>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )
  }

  const NON_CHAT_ROWS = [
    { label: 'terminal', rowName: 'Terminal', tabId: 'term-t1' },
    { label: 'editor', rowName: 'a.ts', tabId: 'edit-/proj/a.ts' },
    { label: 'git', rowName: 'Git Changes', tabId: 'git-/proj' },
    { label: 'git-history', rowName: 'Git History', tabId: 'git-history-/proj' },
    { label: 'browser', rowName: 'Example Site', tabId: 'browser-b1' }
  ]

  it.each(
    NON_CHAT_ROWS
  )('on /snapshots, tapping the $label row activates the tab, closes the drawer and returns to /', ({
    rowName,
    tabId
  }) => {
    seedAllTabTypes()
    renderShellAt('/snapshots')

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByRole('button', { name: rowName }))

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', tabId)
    expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'false')
    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('on /snapshots, an agent-chat row does not navigate to / (setActiveTab owns /c/<id>)', () => {
    seedAllTabTypes()
    renderShellAt('/snapshots')

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByRole('button', { name: 'Hello chat' }))

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'tab-1')
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it.each([
    '/',
    '/c/s1'
  ])('on the workspace route %s, tapping any drawer row never navigates', (path) => {
    seedAllTabTypes()
    renderShellAt(path)

    for (const { rowName } of NON_CHAT_ROWS) {
      fireEvent.click(screen.getByLabelText('Open menu'))
      fireEvent.click(screen.getByRole('button', { name: rowName }))
    }
    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByRole('button', { name: 'Hello chat' }))

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledTimes(NON_CHAT_ROWS.length + 1)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  describe('a row in another pane on /snapshots', () => {
    let pendingFrames: FrameRequestCallback[]
    let raf: { mockRestore: () => void }

    beforeEach(() => {
      // Capture the deferred activation instead of running it, so each test
      // decides when the frame fires. Restored in afterEach so a failing
      // assertion cannot leak the stub into later tests.
      pendingFrames = []
      raf = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback) => {
          pendingFrames.push(callback)
          return pendingFrames.length
        })
      workspaceRef.current = {
        ...workspaceRef.current,
        leaves: [
          { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
          {
            type: 'leaf',
            id: 'pane-2',
            tabs: [{ type: 'git', id: 'git-/proj', cwd: '/proj' }],
            activeTabId: null
          }
        ],
        activePaneId: 'pane-1'
      }
    })

    afterEach(() => {
      raf.mockRestore()
    })

    it('still returns to / after its deferred activation', () => {
      renderShellAt('/snapshots')

      fireEvent.click(screen.getByLabelText('Open menu'))
      fireEvent.click(screen.getByRole('button', { name: 'Git Changes' }))
      for (const frame of pendingFrames) frame(0)

      expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-2', 'git-/proj')
      expect(mockNavigate).toHaveBeenCalledTimes(1)
      expect(mockNavigate).toHaveBeenCalledWith('/')
    })

    it('navigates only after the tab is active, never before the frame fires', () => {
      renderShellAt('/snapshots')

      fireEvent.click(screen.getByLabelText('Open menu'))
      fireEvent.click(screen.getByRole('button', { name: 'Git Changes' }))

      // The drawer closes at once, but neither the activation nor the route
      // change has happened yet: the workspace route must not paint the
      // previously active leaf while the activation is still pending.
      expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'false')
      expect(pendingFrames).toHaveLength(1)
      expect(workspaceRef.current.setActiveTab).not.toHaveBeenCalled()
      expect(mockNavigate).not.toHaveBeenCalled()

      for (const frame of pendingFrames) frame(0)

      const [activation] = workspaceRef.current.setActiveTab.mock.invocationCallOrder
      const [navigation] = mockNavigate.mock.invocationCallOrder
      expect(activation).toBeLessThan(navigation)
    })
  })

  describe('while a pane is fullscreen', () => {
    let raf: { mockRestore: () => void }

    beforeEach(() => {
      // Run the deferred cross-pane activation at once; restored in afterEach
      // so a failing assertion cannot leak the stub into later tests.
      raf = vi
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback) => {
          callback(0)
          return 1
        })
      workspaceRef.current = {
        ...workspaceRef.current,
        leaves: [
          {
            type: 'leaf',
            id: 'pane-1',
            tabs: [{ type: 'git', id: 'git-/a', cwd: '/a' }],
            activeTabId: 'git-/a'
          },
          {
            type: 'leaf',
            id: 'pane-2',
            tabs: [{ type: 'git-history', id: 'git-history-/b', cwd: '/b' }],
            activeTabId: 'git-history-/b'
          }
        ],
        activePaneId: 'pane-1',
        fullscreenPaneId: 'pane-1'
      }
    })

    afterEach(() => {
      raf.mockRestore()
    })

    function tapRow(name: string): void {
      renderShellAt('/')
      fireEvent.click(screen.getByLabelText('Open menu'))
      fireEvent.click(screen.getByRole('button', { name }))
    }

    it('leaves fullscreen before activating a tab in another leaf, so the view follows it', () => {
      tapRow('Git History')

      expect(workspaceRef.current.clearFullscreenPane).toHaveBeenCalledTimes(1)
      expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-2', 'git-history-/b')
      // Cleared first: with fullscreen still set, setActiveTab would keep
      // activePaneId on the fullscreen leaf.
      const [clearing] = workspaceRef.current.clearFullscreenPane.mock.invocationCallOrder
      const [activation] = workspaceRef.current.setActiveTab.mock.invocationCallOrder
      expect(clearing).toBeLessThan(activation)
    })

    it('keeps fullscreen when the row belongs to the fullscreen leaf', () => {
      tapRow('Git Changes')

      expect(workspaceRef.current.clearFullscreenPane).not.toHaveBeenCalled()
      expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'git-/a')
    })

    it('leaves a fullscreen leaf that is not the active one, even for a row in the active leaf', () => {
      // `loadProjectWorkspace` can keep a stale fullscreenPaneId, which would
      // otherwise hand activePaneId back to the fullscreen leaf.
      workspaceRef.current.fullscreenPaneId = 'pane-2'
      tapRow('Git Changes')

      expect(workspaceRef.current.clearFullscreenPane).toHaveBeenCalledTimes(1)
      expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'git-/a')
    })

    it('never touches fullscreen when no pane is fullscreen', () => {
      workspaceRef.current.fullscreenPaneId = null
      tapRow('Git History')

      expect(workspaceRef.current.clearFullscreenPane).not.toHaveBeenCalled()
      expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-2', 'git-history-/b')
    })
  })
})
