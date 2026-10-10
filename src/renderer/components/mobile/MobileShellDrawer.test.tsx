import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { type ComponentProps, type MutableRefObject, useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AskUserQuestion } from '@/components/chat/AskUserQuestion'
import { logFrontendError } from '@/lib/log-api'
import { _resetSheetFocusReturnForTests, recordSheetOpener } from '@/lib/sheet-focus-return'
import { mockSessionIndexEntry } from '@/lib/test-utils/acp'
import {
  _resetEphemeralSessionIdsForTesting,
  type PendingQuestion,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'
import { useConnectionStatusStore } from '@/stores/connection-status-store'
import { useOverlayStackStore } from '@/stores/overlay-stack-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsModalStore, useSettingsModalView } from '@/stores/settings-modal-store'
import type { Project } from '@/types/project'
import { MobileShellDrawer } from './MobileShellDrawer'
import { MobileShellHeader } from './MobileShellHeader'

const {
  mockNavigate,
  locationRef,
  tauriRef,
  workspaceRef,
  mockAddAgentChatTab,
  mockOpenHistorySession,
  terminalsRef,
  editorRef,
  browserTabsRef
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  locationRef: { current: { pathname: '/' } },
  tauriRef: { current: false as boolean },
  workspaceRef: {
    current: {
      leaves: [] as Array<{
        type: 'leaf'
        id: string
        tabs: Array<Record<string, unknown>>
        activeTabId: string | null
      }>,
      activePaneId: 'pane-1',
      removeTab: vi.fn(),
      setActiveTab: vi.fn()
    }
  },
  mockAddAgentChatTab: vi.fn(),
  mockOpenHistorySession: vi.fn(),
  terminalsRef: { current: [] as Array<{ id: string; name: string }> },
  editorRef: { current: { openFiles: new Map<string, { isDirty: boolean }>() } },
  browserTabsRef: { current: new Map<string, unknown>() }
}))

const mockDeleteHistorySession = vi.fn()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ ...locationRef.current, search: '', hash: '', state: null, key: 'test' })
  }
})

vi.mock('@/lib/tauri-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri-runtime')>()),
  isTauriContext: () => tauriRef.current
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

vi.mock('@/stores/workspace-store', () => ({
  getAllLeafPanes: () => workspaceRef.current.leaves,
  useWorkspaceStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) =>
      sel({
        root: { leaves: workspaceRef.current.leaves },
        activePaneId: workspaceRef.current.activePaneId,
        removeTab: workspaceRef.current.removeTab,
        setActiveTab: workspaceRef.current.setActiveTab,
        addAgentChatTab: mockAddAgentChatTab
      })
    ),
    { getState: () => workspaceRef.current }
  )
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: Object.assign(
    vi.fn((sel: (s: { terminals: unknown[] }) => unknown) =>
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
      sel({ tabs: browserTabsRef.current, removeTab: vi.fn() })
    ),
    { getState: () => ({ tabs: browserTabsRef.current, removeTab: vi.fn() }) }
  )
}))

type DrawerProps = ComponentProps<typeof MobileShellDrawer>

interface HarnessControls {
  hideTempOpener: () => void
}

const QUESTION = {
  questionId: 'q1',
  agentId: 'agent-1',
  sessionId: 's1',
  question: 'Which approach?',
  options: [
    { value: 'a', label: 'Plan A' },
    { value: 'b', label: 'Plan B' }
  ]
} as PendingQuestion

/** A stand-in for the chat pane `PaneContent` mounts behind the drawer. */
interface ChatPane {
  /** `data-chat-tab-state`: hidden chat tabs stay mounted behind the visible one. */
  state: 'visible' | 'hidden'
  /**
   * A real `AskUserQuestion`, a bare permission prompt (no question), or a
   * question whose only option cannot take focus.
   */
  prompt: 'question' | 'permission' | 'locked-question'
}

/**
 * Mirrors MobileChatShell's wiring: ☰ and a second opener both go through
 * `openDrawer`, which records the opener (☰ as the fallback) in the focus-return
 * registry; "launcher" and "projects" stand in for the overlays the hand-off
 * rows open (a dialog that takes focus on mount).
 */
function Harness({
  controlsRef,
  withTitle = true,
  overlays = true,
  chat,
  promptGrabsFocus = false,
  ...props
}: Partial<DrawerProps> & {
  controlsRef?: MutableRefObject<HarnessControls | null>
  /** Render the shell header's `#mobile-shell-title` focus target. */
  withTitle?: boolean
  /** Whether hand-off rows open a dialog that takes focus. */
  overlays?: boolean
  /** Mount a chat pane behind the drawer. */
  chat?: ChatPane
  /** A prompt field in the chat pane takes focus itself once the drawer has closed. */
  promptGrabsFocus?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [showTemp, setShowTemp] = useState(true)
  const menuRef = useRef<HTMLButtonElement>(null)
  const promptFieldRef = useRef<HTMLInputElement>(null)
  const wasOpenRef = useRef(false)
  const settingsView = useSettingsModalView()
  if (controlsRef) controlsRef.current = { hideTempOpener: () => setShowTemp(false) }
  const openDrawer = (opener: HTMLElement | null): void => {
    recordSheetOpener('mobile-drawer', opener ?? menuRef.current, menuRef.current)
    setOpen(true)
  }
  // The question's own arrival focus, after the drawer's focus trap is gone.
  useEffect(() => {
    if (open) wasOpenRef.current = true
    else if (wasOpenRef.current && promptGrabsFocus) promptFieldRef.current?.focus()
  }, [open, promptGrabsFocus])
  return (
    <>
      <button ref={menuRef} type="button" onClick={(e) => openDrawer(e.currentTarget)}>
        Open menu
      </button>
      <button type="button" onClick={(e) => openDrawer(e.currentTarget)}>
        Second opener
      </button>
      {showTemp && (
        <button type="button" onClick={(e) => openDrawer(e.currentTarget)}>
          Temporary opener
        </button>
      )}
      <button type="button" onClick={() => setOpen(false)}>
        Close like back
      </button>
      {withTitle && (
        <h1 id="mobile-shell-title" tabIndex={-1}>
          Shell title
        </h1>
      )}
      {chat && (
        <div data-chat-tab-state={chat.state}>
          {chat.prompt === 'question' && <AskUserQuestion question={QUESTION} />}
          {chat.prompt === 'permission' && (
            <div data-approval-prompt="permission:r1">
              <button type="button">Allow once</button>
            </div>
          )}
          {chat.prompt === 'locked-question' && (
            <div data-approval-prompt="question:q-locked">
              <button type="button" aria-pressed="false" disabled>
                Locked option
              </button>
            </div>
          )}
          {promptGrabsFocus && (
            <div data-approval-prompt="elicitation:e1">
              <input ref={promptFieldRef} aria-label="Prompt field" />
            </div>
          )}
        </div>
      )}
      <MobileShellDrawer
        open={open}
        onOpenChange={setOpen}
        activeTabId={null}
        activeSessionId={null}
        canNewChat
        onNewChat={() => overlays && setLauncherOpen(true)}
        onOpenProjects={() => overlays && setProjectsOpen(true)}
        {...props}
      />
      {launcherOpen && <FocusedDialog label="Launcher" />}
      {projectsOpen && <FocusedDialog label="Project sheet" />}
      {overlays && settingsView === 'app' && <FocusedDialog label="Settings dialog" />}
    </>
  )
}

function FocusedDialog({ label }: { label: string }): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  return (
    <div role="dialog" aria-label={label}>
      <input ref={inputRef} aria-label={`${label} field`} />
    </div>
  )
}

const CHAT_TAB = { type: 'agent-chat', id: 'tab-1', sessionId: 's1' }

function seedTabs(tabs: Array<Record<string, unknown>>, activeTabId: string | null = null): void {
  workspaceRef.current = {
    ...workspaceRef.current,
    leaves: [{ type: 'leaf', id: 'pane-1', tabs, activeTabId }],
    activePaneId: 'pane-1'
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'termul',
    color: 'blue',
    path: '/work',
    gitBranch: 'main',
    isGitRepo: true,
    worktrees: [],
    activeWorktreeId: null,
    ...overrides
  }
}

function seedProject(project: Project | null): void {
  useProjectStore.setState({
    projects: project ? [project] : [],
    activeProjectId: project ? project.id : ''
  })
}

function seedHistory(titles: string[]): void {
  useAcpStore.setState({
    sessionIndex: titles.map((title, i) =>
      mockSessionIndexEntry({
        id: `h${i}`,
        title,
        projectId: 'p1',
        cwd: '/work',
        status: 'active',
        lastActivityAt: Date.now() - i
      })
    ),
    openHistorySession: mockOpenHistorySession,
    deleteHistorySession: mockDeleteHistorySession
  })
}

/** Render the harness, open the drawer from ☰ and wait for it to mount. */
async function openDrawer(props: Parameters<typeof Harness>[0] = {}) {
  const view = render(<Harness {...props} />)
  const menu = screen.getByRole('button', { name: 'Open menu' })
  fireEvent.click(menu)
  const dialog = await screen.findByRole('dialog', { name: 'Termul' })
  return { ...view, menu, dialog }
}

async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

beforeEach(async () => {
  mockNavigate.mockReset()
  // A drawer the previous test left mounted is unmounted by cleanup, and Radix
  // fires its close-focus handler in a setTimeout(0). Let that run before this
  // test records its own opener, which the handler would otherwise consume.
  await new Promise((resolve) => setTimeout(resolve, 0))
  _resetSheetFocusReturnForTests()
  locationRef.current = { pathname: '/' }
  mockAddAgentChatTab.mockReset()
  mockOpenHistorySession.mockReset().mockResolvedValue(undefined)
  mockDeleteHistorySession.mockReset().mockResolvedValue(undefined)
  tauriRef.current = false
  workspaceRef.current.removeTab.mockReset()
  workspaceRef.current.setActiveTab.mockReset()
  seedTabs([])
  terminalsRef.current = []
  editorRef.current.openFiles = new Map()
  browserTabsRef.current = new Map()
  useAcpStore.setState(FRESH)
  _resetEphemeralSessionIdsForTesting()
  useAgentChatLifetimeStore.setState({ closingSessionIds: {} })
  useAgentChatUnreadStore.setState({ unread: {} })
  useConnectionStatusStore.setState({ controlChannel: 'connected', terminalChannel: 'connected' })
  useSettingsModalStore.setState({ view: null })
  seedProject(makeProject())
})

describe('MobileShellDrawer shell', () => {
  it('is the full-screen left sheet #mobile-shell-drawer, named Termul, with the project row as its top row beside the close', async () => {
    const { dialog } = await openDrawer()

    expect(dialog.id).toBe('mobile-shell-drawer')
    expect(dialog.className).toContain('w-full')
    expect(dialog.className).toContain('pt-[env(safe-area-inset-top)]')
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument()
    expect(dialog.className).toContain('flex-col')
    // On web the title only names the dialog: the project row is the visible top row.
    const title = within(dialog).getByRole('heading', { level: 2, name: 'Termul' })
    expect(title).toHaveAttribute('tabindex', '-1')
    expect(title).toHaveClass('sr-only')
    const projectRow = within(dialog).getByRole('button', { name: /termul/ })
    const topRow = title.parentElement
    expect(topRow).toContainElement(projectRow)
    // The row leaves room for the close × in the corner.
    expect(topRow).toHaveClass('pr-10', 'min-h-11')
    expect(
      projectRow.compareDocumentPosition(
        within(dialog).getByRole('navigation', { name: 'Sections' })
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(within(dialog).getByText('Browse and open chats, terminals and editors')).toHaveClass(
      'sr-only'
    )
  })

  it('orders project row, section tabs, search, Recents, footer and the New chat pill on Chats', async () => {
    seedTabs([CHAT_TAB], 'tab-1')
    seedOptionsSession('s1', 'agent-1', { title: 'Chat one' })
    seedHistory(['Past chat'])
    const { dialog } = await openDrawer({
      activeTabId: 'tab-1',
      activeSessionId: 's1',
      onOpenGitHistory: vi.fn()
    })

    const nav = within(dialog).getByRole('navigation', { name: 'Sections' })
    const inOrder = [
      within(dialog).getByRole('button', { name: /termul/ }),
      within(nav).getByRole('button', { name: 'Chats' }),
      within(nav).getByRole('button', { name: 'Terminals' }),
      within(nav).getByRole('button', { name: 'Editors' }),
      within(dialog).getByRole('textbox', { name: 'Search chats' }),
      within(dialog).getByRole('heading', { level: 2, name: 'Recents' }),
      within(dialog).getByRole('heading', { level: 3, name: 'Today' }),
      within(dialog).getByRole('button', { name: 'Chat one' }),
      within(dialog).getByRole('button', { name: /^Past chat/ }),
      within(dialog).getByRole('button', { name: 'Settings' }),
      within(dialog).getByRole('button', { name: 'Snapshots' }),
      within(dialog).getByRole('button', { name: 'Git history' }),
      within(dialog).getByRole('button', { name: 'New chat' }),
      within(dialog).getByText(`Connected · ${window.location.host}`)
    ]
    for (let i = 1; i < inOrder.length; i++) {
      expect(
        inOrder[i - 1].compareDocumentPosition(inOrder[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${i}: ${inOrder[i].textContent} follows ${inOrder[i - 1].textContent}`
      ).toBeTruthy()
    }
  })

  it('shows one Recents list on Chats: no Open, Terminals, Tabs or History headings', async () => {
    seedTabs(
      [
        { type: 'terminal', id: 'term-t1', terminalId: 't1' },
        { type: 'git', id: 'git-/p', cwd: '/p' },
        CHAT_TAB
      ],
      'tab-1'
    )
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
    seedOptionsSession('s1', 'agent-1', { title: 'Chat one' })
    seedHistory(['Past chat'])
    const { dialog } = await openDrawer({ activeTabId: 'tab-1', activeSessionId: 's1' })

    const recents = within(dialog).getByRole('heading', { level: 2, name: 'Recents' })
    expect(recents).toHaveAttribute('tabindex', '-1')
    expect(within(dialog).getByRole('group', { name: 'Today' })).toBeInTheDocument()
    for (const name of ['Open', 'Terminals', 'Tabs', 'History']) {
      expect(within(dialog).queryByRole('heading', { name }), name).not.toBeInTheDocument()
    }
    expect(within(dialog).queryByRole('button', { name: 'zsh' })).not.toBeInTheDocument()
  })

  it('lists the Terminals section with its New terminal pill and no search', async () => {
    seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }, CHAT_TAB], 'term-t1')
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
    const onNewTerminal = vi.fn()
    const { dialog } = await openDrawer({
      section: 'terminals',
      activeTabId: 'term-t1',
      onNewTerminal
    })

    expect(within(dialog).getByRole('heading', { level: 2, name: 'Terminals' })).toBeInTheDocument()
    expect(within(dialog).getByRole('group', { name: 'Terminals' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('textbox', { name: 'Search chats' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'New chat' })).not.toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'New terminal' }))
    expect(onNewTerminal).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
  })

  it('lists the Editors section with a Browse files pill', async () => {
    seedTabs([{ type: 'editor', id: 'edit-/p/a.ts', filePath: '/p/a.ts' }], null)
    const onOpenFiles = vi.fn()
    const { dialog } = await openDrawer({ section: 'editors', onOpenFiles })

    expect(within(dialog).getByRole('heading', { level: 2, name: 'Editors' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'a.ts' })).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Browse files' }))
    expect(onOpenFiles).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
  })

  it('holds its list still while open, and follows the section again once closed', async () => {
    seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }], 'term-t1')
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
    const { dialog, menu, rerender } = await openDrawer({ section: 'terminals' })
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Terminals' })).toBeInTheDocument()

    // The section on screen changes underneath (its last tab closed).
    rerender(<Harness section="editors" />)
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Terminals' })).toBeInTheDocument()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
    fireEvent.click(menu)
    const reopened = await screen.findByRole('dialog', { name: 'Termul' })
    expect(within(reopened).getByRole('heading', { level: 2, name: 'Editors' })).toBeInTheDocument()
  })

  it('offers no New project button (the header action is the in-shell entry)', async () => {
    const { dialog } = await openDrawer({ onOpenGitHistory: vi.fn() })

    expect(within(dialog).queryByRole('button', { name: 'New project' })).not.toBeInTheDocument()
  })

  it('keeps Settings and Snapshots on Tauri but drops the web-only rows and the connection indicator', async () => {
    tauriRef.current = true
    const { dialog } = await openDrawer({ onOpenGitHistory: vi.fn() })

    // No project row on Tauri: a small visible wordmark title takes the top row.
    const title = within(dialog).getByRole('heading', { level: 2, name: 'Termul' })
    expect(title).not.toHaveClass('sr-only')
    expect(title.parentElement?.querySelector('svg[aria-label="Termul"]')).toBeTruthy()

    expect(within(dialog).queryByRole('button', { name: /termul/ })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Snapshots' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Git history' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument()
  })

  it('renders the Recents empty state', async () => {
    useAcpStore.setState({ sessionIndex: [] })
    const { dialog } = await openDrawer()

    expect(
      within(dialog).getByText('No chats yet. Start one with the New chat button.')
    ).toBeInTheDocument()
  })

  it('scrolls the body between a pinned top and a pinned footer', async () => {
    const { dialog } = await openDrawer()

    const body = within(dialog).getByRole('heading', { level: 2, name: 'Recents' }).parentElement
    expect(body).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'overscroll-contain')
    const footer = within(dialog).getByRole('button', { name: 'Settings' }).parentElement
      ?.parentElement
    expect(footer).toHaveClass('border-t')
    expect(footer?.className).toContain('pb-[max(0.5rem,env(safe-area-inset-bottom))]')
  })
})

describe('MobileShellDrawer section nav', () => {
  const navButton = (dialog: HTMLElement, name: string | RegExp): HTMLElement =>
    within(within(dialog).getByRole('navigation', { name: 'Sections' })).getByRole('button', {
      name
    })

  it('shows Chats, Terminals and Editors as one row of equal 44px tabs, the preselected one current', async () => {
    seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }], 'term-t1')
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
    const { dialog } = await openDrawer({ section: 'terminals', activeTabId: 'term-t1' })

    const rows = within(within(dialog).getByRole('navigation', { name: 'Sections' })).getAllByRole(
      'button'
    )
    expect(rows.map((row) => row.textContent)).toEqual(['Chats', 'Terminals', 'Editors'])
    // One line: the three tabs are siblings in one horizontal flex track,
    // each taking an equal share.
    const track = rows[0].parentElement
    expect(track).toHaveClass('flex', 'rounded-full', 'bg-secondary')
    expect(track?.className).not.toContain('flex-col')
    for (const row of rows) {
      expect(row.parentElement).toBe(track)
      expect(row).toHaveClass('min-h-11', 'flex-1', 'rounded-full')
      expect(row).toHaveAttribute('data-section-nav')
    }
    expect(navButton(dialog, 'Terminals')).toHaveAttribute('aria-current', 'true')
    expect(navButton(dialog, 'Terminals')).toHaveClass('bg-background')
    expect(navButton(dialog, 'Chats')).not.toHaveAttribute('aria-current')
    // Focus lands on the active list row, not the nav.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'zsh' })).toHaveFocus())
  })

  it('preselects Chats when no section applies (no tab, Git History)', async () => {
    const { dialog } = await openDrawer({ section: null })

    expect(navButton(dialog, 'Chats')).toHaveAttribute('aria-current', 'true')
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Recents' })).toBeInTheDocument()
  })

  it('switches the list without closing the drawer or changing the active tab', async () => {
    seedTabs(
      [
        { type: 'terminal', id: 'term-t1', terminalId: 't1' },
        { type: 'terminal', id: 'term-t2', terminalId: 't2' },
        CHAT_TAB
      ],
      'tab-1'
    )
    terminalsRef.current = [
      { id: 't1', name: 'alpha' },
      { id: 't2', name: 'beta' }
    ]
    seedOptionsSession('s1', 'agent-1', { title: 'Chat one' })
    const { dialog } = await openDrawer({ section: 'chats', activeTabId: 'tab-1' })

    fireEvent.click(navButton(dialog, 'Terminals'))

    expect(screen.getByRole('dialog', { name: 'Termul' })).toBe(dialog)
    expect(navButton(dialog, 'Terminals')).toHaveAttribute('aria-current', 'true')
    const group = within(dialog).getByRole('group', { name: 'Terminals' })
    expect(within(group).getByRole('button', { name: 'alpha' })).toBeInTheDocument()
    expect(within(group).getByRole('button', { name: 'beta' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('textbox', { name: 'Search chats' })).not.toBeInTheDocument()
    expect(workspaceRef.current.setActiveTab).not.toHaveBeenCalled()

    // A list row opens its tab and closes the drawer.
    fireEvent.click(within(group).getByRole('button', { name: 'beta' }))
    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'term-t2')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
  })

  it('shows an empty line and the primary pill for a section with no tab', async () => {
    const onOpenFiles = vi.fn()
    const { dialog } = await openDrawer({ onOpenFiles, onNewTerminal: vi.fn() })

    fireEvent.click(navButton(dialog, 'Terminals'))
    expect(within(dialog).getByText('No open terminals')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'New terminal' })).toBeInTheDocument()

    fireEvent.click(navButton(dialog, 'Editors'))
    expect(within(dialog).getByText('No open editors')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Browse files' }))
    expect(onOpenFiles).toHaveBeenCalledTimes(1)
  })

  it.each([
    [1, 'Chats, 1 needs you', '1'],
    [3, 'Chats, 3 need you', '3'],
    [12, 'Chats, 12 need you', '9+']
  ])('badges Chats for %i chats that need the user', async (count, name, shown) => {
    const { dialog } = await openDrawer({ attentionCount: count })

    expect(navButton(dialog, name)).toBeInTheDocument()
    expect(within(dialog).getByTestId('drawer-attention-badge')).toHaveTextContent(shown)
  })

  it('shows no badge with nothing needing the user', async () => {
    const { dialog } = await openDrawer()

    expect(navButton(dialog, 'Chats')).toBeInTheDocument()
    expect(within(dialog).queryByTestId('drawer-attention-badge')).not.toBeInTheDocument()
  })

  it('preselects again on the next open after a nav switch', async () => {
    const { dialog, menu } = await openDrawer({ section: 'chats' })
    fireEvent.click(navButton(dialog, 'Editors'))

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
    fireEvent.click(menu)
    const reopened = await screen.findByRole('dialog', { name: 'Termul' })

    expect(navButton(reopened, 'Chats')).toHaveAttribute('aria-current', 'true')
  })
})

describe('MobileShellDrawer search', () => {
  it('is a labelled 44px text-base field, and never takes focus when the drawer opens', async () => {
    const { dialog } = await openDrawer()

    const search = within(dialog).getByRole('textbox', { name: 'Search chats' })
    expect(search).toHaveAttribute('placeholder', 'Search chats…')
    expect(search).toHaveClass('min-h-11', 'text-base')
    await settle()
    expect(search).not.toHaveFocus()
  })

  it('filters the merged Recents list, open chats included', async () => {
    seedTabs([CHAT_TAB], 'tab-1')
    seedOptionsSession('s1', 'agent-1', { title: 'Open chat' })
    seedHistory(['alpha plan', 'beta plan'])
    const { dialog } = await openDrawer({ activeTabId: 'tab-1', activeSessionId: 's1' })
    expect(within(dialog).getByText('alpha plan')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Open chat' })).toBeInTheDocument()

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search chats' }), {
      target: { value: 'alpha' }
    })

    expect(within(dialog).getByText('alpha plan')).toBeInTheDocument()
    expect(within(dialog).queryByText('beta plan')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Open chat' })).not.toBeInTheDocument()

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search chats' }), {
      target: { value: 'zzz' }
    })
    expect(within(dialog).getByText('No chats match this search.')).toBeInTheDocument()
  })

  it('resets the query when the drawer closes', async () => {
    seedHistory(['alpha plan', 'beta plan'])
    const { dialog, menu } = await openDrawer()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search chats' }), {
      target: { value: 'alpha' }
    })
    expect(screen.queryByText('beta plan')).not.toBeInTheDocument()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())

    fireEvent.click(menu)
    const reopened = await screen.findByRole('dialog', { name: 'Termul' })
    expect(within(reopened).getByRole('textbox', { name: 'Search chats' })).toHaveValue('')
    expect(within(reopened).getByText('beta plan')).toBeInTheDocument()
  })
})

describe('MobileShellDrawer New chat', () => {
  it('is a compact rounded-full default pill with a 44px hit area that hands off to the launcher', async () => {
    const onNewChat = vi.fn()
    const { dialog } = await openDrawer({ onNewChat })

    const button = within(dialog).getByRole('button', { name: 'New chat' })
    // 36px visual pill; the ::after hit-slop (-inset-1) keeps the tap area at 44px.
    expect(button).toHaveClass('h-9', 'rounded-full', 'bg-primary-fill', 'after:-inset-1')
    fireEvent.click(button)

    expect(onNewChat).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
  })

  it('is disabled when a chat cannot be started', async () => {
    const onNewChat = vi.fn()
    const { dialog } = await openDrawer({ canNewChat: false, onNewChat })

    const button = within(dialog).getByRole('button', { name: 'New chat' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onNewChat).not.toHaveBeenCalled()
  })
})

describe('MobileShellDrawer footer', () => {
  it('has 44px Settings, Snapshots and Git history buttons', async () => {
    const { dialog } = await openDrawer({ onOpenGitHistory: vi.fn() })

    for (const name of ['Settings', 'Snapshots', 'Git history']) {
      const button = within(dialog).getByRole('button', { name })
      expect(button, name).toHaveClass('size-11')
      expect(button.className, name).not.toMatch(/\bsize-9\b/)
    }
  })

  it('opens App Preferences from Settings and closes the drawer', async () => {
    const { dialog } = await openDrawer()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Settings' }))

    expect(useSettingsModalStore.getState().view).toBe('app')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
  })

  it('navigates to /snapshots from the drawer and closes it', async () => {
    const { dialog } = await openDrawer()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Snapshots' }))

    expect(mockNavigate).toHaveBeenCalledWith('/snapshots')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
  })

  it('returns to the workspace after a terminal row is chosen off the workspace route', async () => {
    locationRef.current = { pathname: '/snapshots' }
    seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }], null)
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
    const { dialog } = await openDrawer({ section: 'terminals' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'zsh' }))

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'term-t1')
    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('stays on the workspace route when a terminal row is chosen there', async () => {
    seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }], null)
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
    const { dialog } = await openDrawer({ section: 'terminals' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'zsh' }))

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'term-t1')
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('mounts the Git history trigger in web mode and invokes onOpenGitHistory', async () => {
    const onOpenGitHistory = vi.fn()
    const { dialog } = await openDrawer({ onOpenGitHistory })

    const button = within(dialog).getByRole('button', { name: 'Git history' })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)

    expect(onOpenGitHistory).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
  })

  it('hides the Git history button without a handler', async () => {
    const { dialog } = await openDrawer()

    expect(within(dialog).queryByRole('button', { name: 'Git history' })).not.toBeInTheDocument()
  })

  it('disables the Git history button when the active project has no path', async () => {
    seedProject(makeProject({ path: undefined }))
    const { dialog } = await openDrawer({ onOpenGitHistory: vi.fn() })

    expect(within(dialog).getByRole('button', { name: 'Git history' })).toBeDisabled()
  })

  it('shows the connection summary as visible text in the footer', async () => {
    const { dialog } = await openDrawer()

    const status = within(dialog).getByRole('status')
    expect(status).toHaveTextContent(`Connected · ${window.location.host}`)
    expect(status).toHaveClass('text-2xs', 'text-muted-foreground')
    expect(status).not.toHaveAttribute('aria-label')
    expect(status.querySelector('svg')?.getAttribute('class')).toContain('text-connection')
  })

  it('names the host this client talks to, one text node that may wrap', async () => {
    const { dialog } = await openDrawer()

    const label = within(dialog).getByText(`Connected · ${window.location.host}`)
    expect(window.location.host).not.toBe('')
    expect(label.childNodes).toHaveLength(1)
    expect(label).toHaveClass('min-w-0', 'break-words')
  })

  it('shows no connection status on Tauri, as before', async () => {
    tauriRef.current = true
    const { dialog } = await openDrawer()

    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/Connected/)).not.toBeInTheDocument()
  })

  it('names the degraded channel and warns', async () => {
    useConnectionStatusStore.setState({ controlChannel: 'reconnecting' })
    const { dialog } = await openDrawer()

    const status = within(dialog).getByRole('status')
    expect(status).toHaveTextContent('Control channel: reconnecting')
    expect(status).not.toHaveTextContent(window.location.host)
    expect(status.querySelector('svg')?.getAttribute('class')).toContain('text-warning')
  })

  it('turns destructive when the terminal channel is disconnected', async () => {
    useConnectionStatusStore.setState({ terminalChannel: 'disconnected' })
    const { dialog } = await openDrawer()

    const status = within(dialog).getByRole('status')
    expect(status).toHaveTextContent('Terminal channel: disconnected')
    expect(status.querySelector('svg')?.getAttribute('class')).toContain('text-destructive')
  })
})

describe('MobileShellDrawer close confirm hand-off', () => {
  beforeEach(() => {
    useOverlayStackStore.setState({ stack: [] })
    seedTabs(
      [
        { type: 'terminal', id: 'term-t1', terminalId: 't1' },
        { type: 'editor', id: 'edit-/p/a.ts', filePath: '/p/a.ts' }
      ],
      null
    )
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
  })

  afterEach(() => {
    useOverlayStackStore.setState({ stack: [] })
    document.querySelectorAll('[data-sibling-dialog]').forEach((node) => {
      node.remove()
    })
  })

  /**
   * Stands in for `ConfirmDialog`: it registers on the overlay stack, keeps a
   * `data-sibling-dialog` root in the DOM, and never takes focus on its own
   * (a tap on Cancel focuses Cancel; closing it drops focus to <body>).
   */
  function openFakeConfirm(): { cancel: () => void } {
    const root = document.createElement('div')
    root.setAttribute('data-sibling-dialog', '')
    const cancelButton = document.createElement('button')
    root.appendChild(cancelButton)
    document.body.appendChild(root)
    act(() => useOverlayStackStore.getState().registerOverlay('confirm-dialog:test', () => {}))
    cancelButton.focus()
    return {
      cancel: () =>
        act(() => {
          useOverlayStackStore.getState().unregisterOverlay('confirm-dialog:test')
          root.remove()
        })
    }
  }

  it('makes the section heading programmatically focusable', async () => {
    const { dialog } = await openDrawer({ section: 'terminals' })

    expect(within(dialog).getByRole('heading', { level: 2, name: 'Terminals' })).toHaveAttribute(
      'tabindex',
      '-1'
    )
  })

  it('closes when closing a terminal opened the confirm, and Cancel leaves focus on ☰', async () => {
    const onCloseTerminal = vi.fn(() => true)
    const { dialog, menu } = await openDrawer({ section: 'terminals', onCloseTerminal })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close zsh' }))

    expect(onCloseTerminal).toHaveBeenCalledWith('t1', 'term-t1')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
    const confirm = openFakeConfirm()
    confirm.cancel()

    await waitFor(() => expect(menu).toHaveFocus())
  })

  it('returns focus to the recorded opener, not always ☰', async () => {
    const onCloseTerminal = vi.fn(() => true)
    render(<Harness section="terminals" onCloseTerminal={onCloseTerminal} />)
    const second = screen.getByRole('button', { name: 'Second opener' })
    fireEvent.click(second)
    const dialog = await screen.findByRole('dialog', { name: 'Termul' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close zsh' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
    const confirm = openFakeConfirm()
    confirm.cancel()

    await waitFor(() => expect(second).toHaveFocus())
  })

  it('closes for a dirty editor row whose close opened the confirm', async () => {
    const onCloseEditorTab = vi.fn(() => true)
    const { dialog, menu } = await openDrawer({ section: 'editors', onCloseEditorTab })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close a.ts' }))

    expect(onCloseEditorTab).toHaveBeenCalledWith('/p/a.ts')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
    openFakeConfirm().cancel()
    await waitFor(() => expect(menu).toHaveFocus())
  })

  it('does not take focus back when something else already holds it', async () => {
    const onCloseTerminal = vi.fn(() => true)
    const { dialog } = await openDrawer({ section: 'terminals', onCloseTerminal })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close zsh' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
    const confirm = openFakeConfirm()
    // The confirm's action opened another dialog that took focus.
    const next = document.createElement('input')
    document.body.appendChild(next)
    confirm.cancel()
    next.focus()

    await settle(120)
    expect(next).toHaveFocus()
    next.remove()
  })

  it('stops waiting for the confirm when the drawer unmounts first', async () => {
    const onCloseTerminal = vi.fn(() => true)
    const { dialog, unmount } = await openDrawer({ section: 'terminals', onCloseTerminal })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close zsh' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
    vi.mocked(logFrontendError).mockClear()

    unmount()
    // A cancelled watcher never sees the confirm, so it neither restores focus
    // to the gone opener nor logs a missed target.
    openFakeConfirm().cancel()

    await settle(120)
    expect(logFrontendError).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a terminal closed without a confirm',
      'Close zsh',
      { section: 'terminals' as const, onCloseTerminal: vi.fn(() => false) }
    ],
    [
      'a clean editor tab',
      'Close a.ts',
      { section: 'editors' as const, onCloseEditorTab: vi.fn(() => false) }
    ],
    ['a terminal when no close handler is threaded', 'Close zsh', { section: 'terminals' as const }]
  ])('stays open for %s, so rows can be closed in a row', async (_label, closeName, props) => {
    const { dialog } = await openDrawer(props)

    fireEvent.click(within(dialog).getByRole('button', { name: closeName }))
    await settle()

    expect(screen.getByRole('dialog', { name: 'Termul' })).toBe(dialog)
    expect(useOverlayStackStore.getState().stack.map((entry) => entry.id)).not.toContain(
      'confirm-dialog:test'
    )
  })
})

describe('MobileShellDrawer project row', () => {
  async function projectRow(props: Parameters<typeof Harness>[0] = {}) {
    const { dialog } = await openDrawer(props)
    return within(dialog).getByRole('button', { name: /termul|No project|Demo/ })
  }

  it('shows the project, its branch and Local for a git project', async () => {
    const row = await projectRow()

    expect(row).toHaveAttribute('aria-haspopup', 'dialog')
    expect(row).toHaveClass('min-h-11')
    expect(within(row).getByText('termul')).toHaveClass('text-sm', 'font-medium')
    expect(within(row).getByText('main · Local')).toHaveClass('text-xs', 'text-muted-foreground')
    // The avatar: the monogram tile (ProjectIcon is aria-hidden) and a chevron.
    expect(row.querySelector('[data-project-color="blue"]')).toBeInTheDocument()
    expect(row.querySelector('svg[data-termul-icon="ChevronDown"]')).toBeInTheDocument()
  })

  it('reads No project, with no branch line, when there is no project', async () => {
    seedProject(null)
    const row = await projectRow()

    expect(within(row).getByText('No project')).toBeInTheDocument()
    expect(within(row).queryByText(/·/)).not.toBeInTheDocument()
  })

  it('shows the name only for a non-git project', async () => {
    seedProject(makeProject({ isGitRepo: false, gitBranch: undefined }))
    const row = await projectRow()

    expect(within(row).getByText('termul')).toBeInTheDocument()
    expect(within(row).queryByText(/·/)).not.toBeInTheDocument()
  })

  it('reads Detached HEAD for a git project with no branch', async () => {
    seedProject(makeProject({ gitBranch: undefined }))
    const row = await projectRow()

    expect(within(row).getByText('Detached HEAD · Local')).toBeInTheDocument()
  })

  it('reads the worktree branch and Worktree for an active worktree', async () => {
    seedProject(
      makeProject({
        activeWorktreeId: 'wt1',
        worktrees: [
          { id: 'wt1', name: 'wt', branch: 'chat/fix-auth', path: '/work-wt', createdAt: '' }
        ]
      })
    )
    const row = await projectRow()

    expect(within(row).getByText('chat/fix-auth · Worktree')).toBeInTheDocument()
  })

  it('uses the active chat session worktree and branch inside a chat', async () => {
    seedTabs([CHAT_TAB], 'tab-1')
    seedOptionsSession('s1', 'agent-1', {
      title: 'Chat one',
      worktreePath: '/work-wt',
      worktreeBranch: 'chat/session-branch'
    })
    const row = await projectRow({ activeTabId: 'tab-1', activeSessionId: 's1' })

    expect(within(row).getByText('chat/session-branch · Worktree')).toBeInTheDocument()
  })

  it('reads Worktree alone for a worktree chat with no recorded branch, never the project branch', async () => {
    seedTabs([CHAT_TAB], 'tab-1')
    // The project is on main; the chat runs in a worktree whose branch is unknown.
    seedOptionsSession('s1', 'agent-1', { title: 'Chat one', worktreePath: '/work-wt' })
    const row = await projectRow({ activeTabId: 'tab-1', activeSessionId: 's1' })

    expect(within(row).getByText('Worktree')).toHaveClass('text-xs', 'text-muted-foreground')
    expect(within(row).queryByText(/main/)).not.toBeInTheDocument()
  })

  it('uses the chat project branch for a local chat', async () => {
    seedTabs([CHAT_TAB], 'tab-1')
    seedProject(
      makeProject({
        gitBranch: 'develop',
        // An active worktree must NOT leak into a Local chat's row.
        activeWorktreeId: 'wt1',
        worktrees: [{ id: 'wt1', name: 'wt', branch: 'other', path: '/wt', createdAt: '' }]
      })
    )
    seedOptionsSession('s1', 'agent-1', { title: 'Chat one' })
    const row = await projectRow({ activeTabId: 'tab-1', activeSessionId: 's1' })

    expect(within(row).getByText('develop · Local')).toBeInTheDocument()
  })

  it('is hidden on Tauri', async () => {
    tauriRef.current = true
    const { dialog } = await openDrawer()

    expect(within(dialog).queryByRole('button', { name: /termul/ })).not.toBeInTheDocument()
  })

  it('closes the drawer and opens the project sheet when tapped', async () => {
    const onOpenProjects = vi.fn()
    const row = await projectRow({ onOpenProjects })

    fireEvent.click(row)

    expect(onOpenProjects).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
  })
})

describe('MobileShellDrawer unread tracker', () => {
  it('banks New activity for a chat that finishes while the drawer is closed', async () => {
    seedTabs([CHAT_TAB, { type: 'agent-chat', id: 'tab-2', sessionId: 's2' }], 'tab-1')
    seedOptionsSession('s1', 'agent-1', { title: 'Chat one' })
    seedOptionsSession('s2', 'agent-1', { title: 'Chat two', activeTurn: true, openTurnId: 't1' })
    render(<Harness activeTabId="tab-1" activeSessionId="s1" />)
    const menu = screen.getByRole('button', { name: 'Open menu' })

    // The turn ends behind the closed drawer (its rows are not mounted).
    act(() => {
      const state = useAcpStore.getState()
      useAcpStore.setState({
        sessions: {
          ...state.sessions,
          s2: { ...state.sessions.s2, activeTurn: false, openTurnId: null }
        }
      })
    })
    expect(useAgentChatUnreadStore.getState().unread).toEqual({ s2: true })

    fireEvent.click(menu)
    const dialog = await screen.findByRole('dialog', { name: 'Termul' })
    expect(
      within(dialog).getByRole('button', { name: 'Chat two, New activity' })
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Chat one' })).toBeInTheDocument()
  })
})

describe('MobileShellDrawer History inside the real Sheet', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('observes the lazy-load sentinel against the drawer scroll body', async () => {
    const observed: Array<{ root: Element | null }> = []
    class FakeObserver {
      constructor(_cb: unknown, options: { root: Element | null }) {
        observed.push(options)
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    seedHistory(Array.from({ length: 60 }, (_, i) => `chat-${i}`))
    const { dialog } = await openDrawer()

    const scrollBody = within(dialog).getByRole('heading', {
      level: 2,
      name: 'Recents'
    }).parentElement
    expect(scrollBody).toHaveClass('overflow-y-auto')
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.at(-1)?.root).toBe(scrollBody)
  })

  /** Long-press a Recents row (`contextmenu`) and choose Delete chat in its sheet. */
  async function requestDeleteFromSheet(dialog: HTMLElement, title: string): Promise<HTMLElement> {
    const row = within(dialog).getByRole('button', { name: new RegExp(`^${title}`) })
    fireEvent.contextMenu(row)
    const sheet = await screen.findByRole('dialog', { name: title })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete chat' }))
    return screen.findByRole('alertdialog')
  }

  it('system back with the row actions sheet open closes only the sheet', async () => {
    useOverlayStackStore.setState({ stack: [] })
    seedHistory(['Past chat'])
    const { dialog } = await openDrawer()

    fireEvent.contextMenu(within(dialog).getByRole('button', { name: /^Past chat/ }))
    const sheet = await screen.findByRole('dialog', { name: 'Past chat' })
    expect(useOverlayStackStore.getState().stack.at(-1)?.id).toBe(sheet.id)

    act(() => {
      useOverlayStackStore.getState().closeTopmostOverlay()
    })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Past chat' })).toBeNull())
    expect(screen.getByRole('dialog', { name: 'Termul' })).toBe(dialog)
    useOverlayStackStore.setState({ stack: [] })
  })

  it('opens the delete confirm over the drawer without deleting, and keeps the drawer open', async () => {
    seedHistory(['Past chat'])
    const { dialog } = await openDrawer()

    const confirm = await requestDeleteFromSheet(dialog, 'Past chat')

    expect(within(confirm).getByText('Delete chat')).toBeInTheDocument()
    expect(
      within(confirm).getByText('Delete “Past chat”? This action cannot be undone.')
    ).toBeInTheDocument()
    expect(mockDeleteHistorySession).not.toHaveBeenCalled()
    expect(dialog).toBeInTheDocument()
  })

  it('Cancel returns focus to that row inside the drawer', async () => {
    seedHistory(['First chat', 'Second chat'])
    const { dialog } = await openDrawer()

    await requestDeleteFromSheet(dialog, 'Second chat')
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /^Second chat/ })).toHaveFocus()
    )
    expect(mockDeleteHistorySession).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Termul' })).toBeInTheDocument()
  })

  it('Delete focuses the next visible row', async () => {
    seedHistory(['First chat', 'Second chat', 'Third chat'])
    const { dialog } = await openDrawer()

    const confirm = await requestDeleteFromSheet(dialog, 'First chat')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))

    expect(mockDeleteHistorySession).toHaveBeenCalledWith('h0')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /^Second chat/ })).toHaveFocus()
    )
    expect(screen.getByRole('dialog', { name: 'Termul' })).toBeInTheDocument()
  })

  it('Delete on the last visible row focuses the Recents heading', async () => {
    seedHistory(['Only chat'])
    const { dialog } = await openDrawer()

    const confirm = await requestDeleteFromSheet(dialog, 'Only chat')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))

    expect(mockDeleteHistorySession).toHaveBeenCalledWith('h0')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    const heading = within(dialog).getByRole('heading', { level: 2, name: 'Recents' })
    await waitFor(() => expect(heading).toHaveFocus())
  })
})

describe('MobileShellDrawer focus', () => {
  beforeEach(() => {
    seedTabs([CHAT_TAB], 'tab-1')
    seedOptionsSession('s1', 'agent-1', { title: 'Chat one' })
  })

  describe('on open', () => {
    it('lands on the active Recents row, not the search', async () => {
      const { dialog } = await openDrawer({ activeTabId: 'tab-1', activeSessionId: 's1' })

      const row = within(dialog).getByRole('button', { name: 'Chat one' })
      expect(row).toHaveAttribute('aria-current', 'page')
      await waitFor(() => expect(row).toHaveFocus())
      expect(within(dialog).getByRole('textbox', { name: 'Search chats' })).not.toHaveFocus()
    })

    it('lands on the Termul title when no row is active', async () => {
      const { dialog } = await openDrawer({ activeTabId: null })

      const title = within(dialog).getByRole('heading', { level: 2, name: 'Termul' })
      await waitFor(() => expect(title).toHaveFocus())
      expect(within(dialog).getByRole('textbox', { name: 'Search chats' })).not.toHaveFocus()
    })
  })

  describe('when dismissed', () => {
    it('returns to ☰ on Escape', async () => {
      const { menu } = await openDrawer()

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
      await waitFor(() => expect(menu).toHaveFocus())
    })

    it('keeps the drawer open when Escape ends a terminal rename, and focuses its Rename button', async () => {
      seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }], null)
      terminalsRef.current = [{ id: 't1', name: 'zsh' }]
      const onRenameTerminal = vi.fn()
      const { dialog } = await openDrawer({ section: 'terminals', onRenameTerminal })

      fireEvent.click(within(dialog).getByRole('button', { name: 'Rename zsh' }))
      const input = within(dialog).getByRole('textbox', { name: 'Rename zsh' })
      fireEvent.change(input, { target: { value: 'dev server' } })
      // Radix listens for Escape on the document and would dismiss the sheet:
      // inside a rename field the key only cancels the rename.
      fireEvent.keyDown(input, { key: 'Escape' })

      expect(within(dialog).queryByRole('textbox', { name: 'Rename zsh' })).toBeNull()
      expect(onRenameTerminal).not.toHaveBeenCalled()
      expect(screen.getByRole('dialog', { name: 'Termul' })).toHaveAttribute('data-state', 'open')
      expect(within(dialog).getByRole('button', { name: 'Rename zsh' })).toHaveFocus()
    })

    it('returns to ☰ from the built-in close', async () => {
      const { menu, dialog } = await openDrawer()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
      await waitFor(() => expect(menu).toHaveFocus())
    })

    it('returns to the recorded opener when it was not ☰', async () => {
      render(<Harness />)
      const second = screen.getByRole('button', { name: 'Second opener' })
      fireEvent.click(second)
      await screen.findByRole('dialog', { name: 'Termul' })

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
      await waitFor(() => expect(second).toHaveFocus())
    })

    it('returns to the opener when the drawer is closed from outside (system back)', async () => {
      render(<Harness />)
      const second = screen.getByRole('button', { name: 'Second opener' })
      fireEvent.click(second)
      await screen.findByRole('dialog', { name: 'Termul' })

      // The shell's overlay registration closes it by state, not through Radix.
      fireEvent.click(screen.getByRole('button', { name: 'Close like back', hidden: true }))

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
      await waitFor(() => expect(second).toHaveFocus())
    })

    it('falls back to ☰ when the recorded opener is no longer connected', async () => {
      const controlsRef: MutableRefObject<HarnessControls | null> = { current: null }
      render(<Harness controlsRef={controlsRef} />)
      const menu = screen.getByRole('button', { name: 'Open menu' })
      const temp = screen.getByRole('button', { name: 'Temporary opener' })
      fireEvent.click(temp)
      await screen.findByRole('dialog', { name: 'Termul' })

      act(() => controlsRef.current?.hideTempOpener())
      expect(temp.isConnected).toBe(false)
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
      await waitFor(() => expect(menu).toHaveFocus())
    })
  })

  describe('after a navigation close', () => {
    type Section = 'chats' | 'terminals'
    const NAVIGATIONS: Array<[string, Section, (dialog: HTMLElement) => void]> = [
      [
        'an open chat row',
        'chats',
        (d) => fireEvent.click(within(d).getByRole('button', { name: 'Chat one' }))
      ],
      [
        'a history row',
        'chats',
        (d) => fireEvent.click(within(d).getByRole('button', { name: /^Past chat/ }))
      ],
      [
        'a terminal row',
        'terminals',
        (d) => fireEvent.click(within(d).getByRole('button', { name: 'zsh' }))
      ],
      [
        'New terminal',
        'terminals',
        (d) => fireEvent.click(within(d).getByRole('button', { name: 'New terminal' }))
      ],
      [
        'Snapshots',
        'chats',
        (d) => fireEvent.click(within(d).getByRole('button', { name: 'Snapshots' }))
      ],
      [
        'Git history',
        'chats',
        (d) => fireEvent.click(within(d).getByRole('button', { name: 'Git history' }))
      ]
    ]

    function openWithRows(section: Section, withTitle = true) {
      seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }, CHAT_TAB], 'tab-1')
      terminalsRef.current = [{ id: 't1', name: 'zsh' }]
      seedHistory(['Past chat'])
      return openDrawer({
        section,
        withTitle,
        activeTabId: 'tab-1',
        activeSessionId: 's1',
        onNewTerminal: vi.fn(),
        onOpenGitHistory: vi.fn()
      })
    }

    it.each(
      NAVIGATIONS
    )('moves focus to #mobile-shell-title after %s', async (_name, section, tap) => {
      const { dialog } = await openWithRows(section)

      tap(dialog)

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
      await waitFor(() => expect(document.getElementById('mobile-shell-title')).toHaveFocus())
    })

    it.each(
      NAVIGATIONS
    )('falls back to the opener after %s when there is no title', async (_name, section, tap) => {
      const { dialog, menu } = await openWithRows(section, false)

      tap(dialog)

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
      await waitFor(() => expect(menu).toHaveFocus())
    })
  })

  describe('after a navigation close with a chat pane behind the drawer', () => {
    const tapChatRow = (dialog: HTMLElement): void => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Chat one' }))
    }
    const drawerClosed = (): Promise<void> =>
      waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
    const open = (props: Parameters<typeof Harness>[0]) =>
      openDrawer({ activeTabId: 'tab-1', activeSessionId: 's1', ...props })

    it("focuses the visible chat's open question on its first option, never the pager or Cancel", async () => {
      const { dialog } = await open({ chat: { state: 'visible', prompt: 'question' } })

      tapChatRow(dialog)

      await drawerClosed()
      const firstOption = screen.getByRole('button', { name: /Plan A/ })
      await waitFor(() => expect(firstOption).toHaveFocus())
      expect(screen.getByRole('button', { name: 'Cancel' })).not.toHaveFocus()
      expect(document.getElementById('mobile-shell-title')).not.toHaveFocus()
    })

    it('ignores a question open in a hidden chat tab: focus goes to the title', async () => {
      const { dialog } = await open({ chat: { state: 'hidden', prompt: 'question' } })

      tapChatRow(dialog)

      await drawerClosed()
      await waitFor(() => expect(document.getElementById('mobile-shell-title')).toHaveFocus())
      expect(screen.getByRole('button', { name: /Plan A/, hidden: true })).not.toHaveFocus()
    })

    it('falls through to the title when the first option refuses focus', async () => {
      const { dialog, menu } = await open({ chat: { state: 'visible', prompt: 'locked-question' } })

      tapChatRow(dialog)

      await drawerClosed()
      await waitFor(() => expect(document.getElementById('mobile-shell-title')).toHaveFocus())
      expect(menu).not.toHaveFocus()
    })

    it('goes to the title for a visible chat with only a permission prompt', async () => {
      const { dialog } = await open({ chat: { state: 'visible', prompt: 'permission' } })

      tapChatRow(dialog)

      await drawerClosed()
      await waitFor(() => expect(document.getElementById('mobile-shell-title')).toHaveFocus())
      expect(screen.getByRole('button', { name: 'Allow once' })).not.toHaveFocus()
    })

    it('goes to the title when no chat pane is mounted', async () => {
      const { dialog } = await open({})

      tapChatRow(dialog)

      await drawerClosed()
      await waitFor(() => expect(document.getElementById('mobile-shell-title')).toHaveFocus())
    })

    it('falls back to the opener when there is neither a question nor a title', async () => {
      const { dialog, menu } = await open({ withTitle: false })

      tapChatRow(dialog)

      await drawerClosed()
      await waitFor(() => expect(menu).toHaveFocus())
    })

    it('leaves focus where it is when a prompt already took it', async () => {
      const { dialog, menu } = await open({
        chat: { state: 'visible', prompt: 'question' },
        promptGrabsFocus: true
      })

      tapChatRow(dialog)

      await drawerClosed()
      const field = screen.getByLabelText('Prompt field')
      await settle()
      expect(field).toHaveFocus()
      expect(screen.getByRole('button', { name: /Plan A/ })).not.toHaveFocus()
      expect(document.getElementById('mobile-shell-title')).not.toHaveFocus()
      expect(menu).not.toHaveFocus()
    })

    it('does not move focus to the question on a plain dismissal: back to ☰', async () => {
      const { menu } = await open({ chat: { state: 'visible', prompt: 'question' } })

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await drawerClosed()
      await waitFor(() => expect(menu).toHaveFocus())
    })

    it('does not carry a navigation destination into the next open', async () => {
      const { dialog, menu } = await open({ chat: { state: 'visible', prompt: 'question' } })
      tapChatRow(dialog)
      await drawerClosed()
      await waitFor(() => expect(screen.getByRole('button', { name: /Plan A/ })).toHaveFocus())

      // Reopen from ☰ and dismiss: focus returns to ☰, not the question.
      fireEvent.click(menu)
      await screen.findByRole('dialog', { name: 'Termul' })
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await drawerClosed()
      await waitFor(() => expect(menu).toHaveFocus())
    })
  })

  describe('after a hand-off', () => {
    const HANDOFFS: Array<[string, string, (dialog: HTMLElement) => void]> = [
      [
        'New chat',
        'Launcher field',
        (d) => fireEvent.click(within(d).getByRole('button', { name: 'New chat' }))
      ],
      [
        'Settings',
        'Settings dialog field',
        (d) => fireEvent.click(within(d).getByRole('button', { name: 'Settings' }))
      ],
      [
        'the project row',
        'Project sheet field',
        (d) => fireEvent.click(within(d).getByRole('button', { name: /termul/ }))
      ]
    ]

    it.each(HANDOFFS)('leaves focus in the dialog that %s opened', async (_name, field, tap) => {
      const { dialog, menu } = await openDrawer()

      tap(dialog)

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
      const input = await screen.findByLabelText(field)
      await settle()
      expect(input).toHaveFocus()
      expect(menu).not.toHaveFocus()
    })

    it.each(
      HANDOFFS
    )('falls back to the opener when %s opens nothing that holds focus', async (_name, _field, tap) => {
      const { dialog, menu } = await openDrawer({ overlays: false })

      tap(dialog)

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())
      await waitFor(() => expect(menu).toHaveFocus())
    })
  })
})

describe('MobileShellDrawer opened from the real header', () => {
  /** The real header's ☰ and pill record themselves as the opener, as the shell wires them. */
  function HeaderHarness({ attentionCount = 0 }: { attentionCount?: number }): React.JSX.Element {
    const [open, setOpen] = useState(false)
    const menuRef = useRef<HTMLButtonElement>(null)
    const moreRef = useRef<HTMLButtonElement>(null)
    const subtitleRef = useRef<HTMLButtonElement>(null)
    const titleRef = useRef<HTMLHeadingElement>(null)
    return (
      <>
        <MobileShellHeader
          title="Chat one"
          subtitleText="termul · main · Local"
          subtitleLabel="termul · main, switch project"
          drawerOpen={open}
          onOpenDrawer={(opener) => {
            recordSheetOpener('mobile-drawer', opener ?? menuRef.current, menuRef.current)
            setOpen(true)
          }}
          menuButtonRef={menuRef}
          projectSheetOpen={false}
          onOpenProjectSheet={vi.fn()}
          attentionCount={attentionCount}
          isTerminal={false}
          canNewChat
          onNewChat={vi.fn()}
          moreOpen={false}
          onOpenMore={vi.fn()}
          moreButtonRef={moreRef}
          subtitleRef={subtitleRef}
          titleRef={titleRef}
        />
        <MobileShellDrawer
          open={open}
          onOpenChange={setOpen}
          activeTabId="tab-1"
          activeSessionId="s1"
          canNewChat
          onNewChat={vi.fn()}
          onOpenProjects={vi.fn()}
        />
      </>
    )
  }

  beforeEach(() => {
    seedTabs([CHAT_TAB], 'tab-1')
    seedOptionsSession('s1', 'agent-1', { title: 'Chat one' })
  })

  const drawerClosed = (): Promise<void> =>
    waitFor(() => expect(screen.queryByRole('dialog', { name: 'Termul' })).toBeNull())

  it.each([
    ['☰', 'Open menu', 0],
    ['the attention pill', '2 other chats need you', 2]
  ])('%s: aria-controls resolves to the open Menu dialog', async (_name, label, attentionCount) => {
    render(<HeaderHarness attentionCount={attentionCount} />)
    const control = screen.getByRole('button', { name: label })
    // Closed: the control never references a missing id.
    expect(control).not.toHaveAttribute('aria-controls')

    fireEvent.click(control)

    const dialog = await screen.findByRole('dialog', { name: 'Termul' })
    const controlled = control.getAttribute('aria-controls')
    expect(controlled).toBeTruthy()
    expect(document.getElementById(controlled ?? '')).toBe(dialog)
  })

  it('a navigation then focuses the real header title', async () => {
    render(<HeaderHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    const dialog = await screen.findByRole('dialog', { name: 'Termul' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Chat one' }))

    await drawerClosed()
    const title = screen.getByRole('heading', { level: 1, name: 'Chat one' })
    expect(title).toHaveAttribute('id', 'mobile-shell-title')
    await waitFor(() => expect(title).toHaveFocus())
  })

  it('returns to the pill that opened the drawer', async () => {
    render(<HeaderHarness attentionCount={2} />)
    const pill = screen.getByRole('button', { name: '2 other chats need you' })
    fireEvent.click(pill)
    await screen.findByRole('dialog', { name: 'Termul' })

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await drawerClosed()
    await waitFor(() => expect(pill).toHaveFocus())
  })

  it('falls back to ☰ once the pill is gone', async () => {
    const { rerender } = render(<HeaderHarness attentionCount={2} />)
    const menu = screen.getByRole('button', { name: 'Open menu' })
    const pill = screen.getByRole('button', { name: '2 other chats need you' })
    fireEvent.click(pill)
    await screen.findByRole('dialog', { name: 'Termul' })

    // Nothing needs the user any more: the pill unmounts while the drawer is open.
    rerender(<HeaderHarness attentionCount={0} />)
    expect(pill.isConnected).toBe(false)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await drawerClosed()
    await waitFor(() => expect(menu).toHaveFocus())
  })
})
