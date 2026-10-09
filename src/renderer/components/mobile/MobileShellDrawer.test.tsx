import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { type ComponentProps, type MutableRefObject, useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AskUserQuestion } from '@/components/chat/AskUserQuestion'
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
  const dialog = await screen.findByRole('dialog', { name: 'Menu' })
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
  it('is the left sheet #mobile-shell-drawer, w-[min(82vw,20rem)], titled Menu', async () => {
    const { dialog } = await openDrawer()

    expect(dialog.id).toBe('mobile-shell-drawer')
    expect(dialog.className).toContain('w-[min(82vw,20rem)]')
    expect(dialog.className).toContain('flex-col')
    // The old width token and its invalid cap class are gone.
    expect(dialog.className).not.toContain('w-[72vw]')
    expect(dialog.className).not.toContain('max-w-20rem')
    const title = within(dialog).getByRole('heading', { level: 2, name: 'Menu' })
    expect(title).toHaveAttribute('tabindex', '-1')
    expect(within(dialog).getByText('Browse and open agent chat sessions')).toHaveClass('sr-only')
    expect(within(dialog).queryByText('Chats')).not.toBeInTheDocument()
  })

  it('stacks the sections top to bottom: header, project, search, New chat, Open, History, footer', async () => {
    seedTabs(
      [
        { type: 'terminal', id: 'term-t1', terminalId: 't1' },
        { type: 'editor', id: 'edit-/p/a.ts', filePath: '/p/a.ts' },
        CHAT_TAB
      ],
      'tab-1'
    )
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
    seedOptionsSession('s1', 'agent-1', { title: 'Chat one' })
    seedHistory(['Past chat'])
    const { dialog } = await openDrawer({
      activeTabId: 'tab-1',
      activeSessionId: 's1',
      onOpenGitHistory: vi.fn()
    })

    const inOrder = [
      within(dialog).getByRole('heading', { level: 2, name: 'Menu' }),
      within(dialog).getByRole('button', { name: /termul/ }),
      within(dialog).getByRole('textbox', { name: 'Search chats' }),
      within(dialog).getByRole('button', { name: 'New chat' }),
      within(dialog).getByRole('heading', { level: 2, name: 'Open' }),
      within(dialog).getByRole('button', { name: 'Chat one' }),
      within(dialog).getByRole('heading', { level: 3, name: 'Terminals' }),
      within(dialog).getByRole('heading', { level: 3, name: 'Tabs' }),
      within(dialog).getByRole('heading', { level: 2, name: 'History' }),
      within(dialog).getByRole('heading', { level: 3, name: 'Today' }),
      within(dialog).getByRole('button', { name: 'Settings' }),
      within(dialog).getByRole('button', { name: 'Snapshots' }),
      within(dialog).getByRole('button', { name: 'Git history' }),
      within(dialog).getByText('Connected')
    ]
    for (let i = 1; i < inOrder.length; i++) {
      expect(
        inOrder[i - 1].compareDocumentPosition(inOrder[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${i}: ${inOrder[i].textContent} follows ${inOrder[i - 1].textContent}`
      ).toBeTruthy()
    }
  })

  it('labels its sections as headings with labelled groups', async () => {
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

    for (const [level, name] of [
      [2, 'Open'],
      [3, 'Terminals'],
      [3, 'Tabs'],
      [3, 'Today']
    ] as const) {
      const heading = within(dialog).getByRole('heading', { level, name })
      expect(heading, name).toHaveClass('label-group')
      expect(within(dialog).getByRole('group', { name }), name).toHaveAttribute(
        'aria-labelledby',
        heading.id
      )
    }
    // History is the heading of the recency groups; it is also a focus target.
    const history = within(dialog).getByRole('heading', { level: 2, name: 'History' })
    expect(history).toHaveClass('label-group')
    expect(history).toHaveAttribute('tabindex', '-1')
  })

  it('offers no New project button (the header action is the in-shell entry)', async () => {
    const { dialog } = await openDrawer({ onOpenGitHistory: vi.fn() })

    expect(within(dialog).queryByRole('button', { name: 'New project' })).not.toBeInTheDocument()
  })

  it('keeps Settings and Snapshots on Tauri but drops the web-only rows and the connection indicator', async () => {
    tauriRef.current = true
    const { dialog } = await openDrawer({ onOpenGitHistory: vi.fn() })

    expect(within(dialog).queryByRole('button', { name: /termul/ })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Snapshots' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Git history' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument()
  })

  it('renders the "No open terminals" line and History empty state', async () => {
    useAcpStore.setState({ sessionIndex: [] })
    const { dialog } = await openDrawer()

    expect(within(dialog).getByText('No open terminals')).toBeInTheDocument()
    expect(
      within(dialog).getByText('No chats yet. Start one with the New chat button.')
    ).toBeInTheDocument()
  })

  it('scrolls the body between a pinned top and a pinned footer', async () => {
    const { dialog } = await openDrawer()

    const body = within(dialog).getByRole('heading', { level: 2, name: 'Open' }).parentElement
    expect(body).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'overscroll-contain')
    const footer = within(dialog).getByRole('button', { name: 'Settings' }).parentElement
      ?.parentElement
    expect(footer).toHaveClass('border-t')
    expect(footer?.className).toContain('pb-[max(0.5rem,env(safe-area-inset-bottom))]')
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

  it('filters History rows only, leaving Open rows unchanged', async () => {
    seedTabs([CHAT_TAB], 'tab-1')
    seedOptionsSession('s1', 'agent-1', { title: 'Open chat' })
    seedHistory(['alpha plan', 'beta plan'])
    const { dialog } = await openDrawer({ activeTabId: 'tab-1', activeSessionId: 's1' })
    expect(within(dialog).getByText('alpha plan')).toBeInTheDocument()
    expect(within(dialog).getByText('beta plan')).toBeInTheDocument()

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search chats' }), {
      target: { value: 'alpha' }
    })

    expect(within(dialog).getByText('alpha plan')).toBeInTheDocument()
    expect(within(dialog).queryByText('beta plan')).not.toBeInTheDocument()
    // "Open chat" does not match "alpha", and is still there.
    expect(within(dialog).getByRole('button', { name: 'Open chat' })).toBeInTheDocument()

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search chats' }), {
      target: { value: 'zzz' }
    })
    expect(within(dialog).getByText('No chats match this search.')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Open chat' })).toBeInTheDocument()
  })

  it('resets the query when the drawer closes', async () => {
    seedHistory(['alpha plan', 'beta plan'])
    const { dialog, menu } = await openDrawer()
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search chats' }), {
      target: { value: 'alpha' }
    })
    expect(screen.queryByText('beta plan')).not.toBeInTheDocument()

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())

    fireEvent.click(menu)
    const reopened = await screen.findByRole('dialog', { name: 'Menu' })
    expect(within(reopened).getByRole('textbox', { name: 'Search chats' })).toHaveValue('')
    expect(within(reopened).getByText('beta plan')).toBeInTheDocument()
  })
})

describe('MobileShellDrawer New chat', () => {
  it('is a full-width 44px secondary button that hands off to the launcher', async () => {
    const onNewChat = vi.fn()
    const { dialog } = await openDrawer({ onNewChat })

    const button = within(dialog).getByRole('button', { name: 'New chat' })
    expect(button).toHaveClass('bg-secondary', 'min-h-11', 'w-full')
    fireEvent.click(button)

    expect(onNewChat).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
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
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
  })

  it('navigates to /snapshots from the drawer and closes it', async () => {
    const { dialog } = await openDrawer()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Snapshots' }))

    expect(mockNavigate).toHaveBeenCalledWith('/snapshots')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
  })

  it('returns to the workspace after a terminal row is chosen off the workspace route', async () => {
    locationRef.current = { pathname: '/snapshots' }
    seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }], null)
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
    const { dialog } = await openDrawer()

    fireEvent.click(within(dialog).getByRole('button', { name: 'zsh' }))

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'term-t1')
    expect(mockNavigate).toHaveBeenCalledWith('/')
  })

  it('stays on the workspace route when a terminal row is chosen there', async () => {
    seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }], null)
    terminalsRef.current = [{ id: 't1', name: 'zsh' }]
    const { dialog } = await openDrawer()

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
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
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
    expect(status).toHaveTextContent('Connected')
    expect(status).toHaveClass('text-2xs', 'text-muted-foreground')
    expect(status).not.toHaveAttribute('aria-label')
    expect(status.querySelector('svg')?.getAttribute('class')).toContain('text-connection')
  })

  it('names the degraded channel and warns', async () => {
    useConnectionStatusStore.setState({ controlChannel: 'reconnecting' })
    const { dialog } = await openDrawer()

    const status = within(dialog).getByRole('status')
    expect(status).toHaveTextContent('Control channel: reconnecting')
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
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
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
    const dialog = await screen.findByRole('dialog', { name: 'Menu' })
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

    const scrollBody = within(dialog).getByRole('heading', { level: 2, name: 'Open' }).parentElement
    expect(scrollBody).toHaveClass('overflow-y-auto')
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.at(-1)?.root).toBe(scrollBody)
  })

  it('opens the delete confirm over the drawer without deleting, and keeps the drawer open', async () => {
    seedHistory(['Past chat'])
    const { dialog } = await openDrawer()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Past chat' }))

    const confirm = await screen.findByRole('alertdialog')
    expect(within(confirm).getByText('Delete chat')).toBeInTheDocument()
    expect(
      within(confirm).getByText('Delete “Past chat”? This action cannot be undone.')
    ).toBeInTheDocument()
    expect(mockDeleteHistorySession).not.toHaveBeenCalled()
    expect(dialog).toBeInTheDocument()
  })

  it('Cancel returns focus to that row trash button inside the drawer', async () => {
    seedHistory(['First chat', 'Second chat'])
    const { dialog } = await openDrawer()
    const trash = within(dialog).getByRole('button', { name: 'Delete Second chat' })

    fireEvent.click(trash)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(trash).toHaveFocus())
    expect(mockDeleteHistorySession).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument()
  })

  it('Escape returns focus to that row trash button and leaves the drawer open', async () => {
    seedHistory(['First chat', 'Second chat'])
    const { dialog } = await openDrawer()
    const trash = within(dialog).getByRole('button', { name: 'Delete First chat' })

    fireEvent.click(trash)
    await screen.findByRole('alertdialog')
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(trash).toHaveFocus())
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument()
    expect(mockDeleteHistorySession).not.toHaveBeenCalled()
  })

  it('Delete focuses the next visible row open button', async () => {
    seedHistory(['First chat', 'Second chat', 'Third chat'])
    const { dialog } = await openDrawer()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete First chat' }))
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))

    expect(mockDeleteHistorySession).toHaveBeenCalledWith('h0')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: /^Second chat/ })).toHaveFocus()
    )
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument()
  })

  it('Delete on the last visible row focuses the drawer History heading', async () => {
    seedHistory(['Only chat'])
    const { dialog } = await openDrawer()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Only chat' }))
    const confirm = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))

    expect(mockDeleteHistorySession).toHaveBeenCalledWith('h0')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    const heading = within(dialog).getByRole('heading', { level: 2, name: 'History' })
    await waitFor(() => expect(heading).toHaveFocus())
    expect(screen.getByRole('dialog', { name: 'Menu' })).toBeInTheDocument()
  })
})

describe('MobileShellDrawer focus', () => {
  beforeEach(() => {
    seedTabs([CHAT_TAB], 'tab-1')
    seedOptionsSession('s1', 'agent-1', { title: 'Chat one' })
  })

  describe('on open', () => {
    it('lands on the active Open row, not the search', async () => {
      const { dialog } = await openDrawer({ activeTabId: 'tab-1', activeSessionId: 's1' })

      const row = within(dialog).getByRole('button', { name: 'Chat one' })
      expect(row).toHaveAttribute('aria-current', 'page')
      await waitFor(() => expect(row).toHaveFocus())
      expect(within(dialog).getByRole('textbox', { name: 'Search chats' })).not.toHaveFocus()
    })

    it('lands on the Menu title when no Open row is active', async () => {
      const { dialog } = await openDrawer({ activeTabId: null })

      const title = within(dialog).getByRole('heading', { level: 2, name: 'Menu' })
      await waitFor(() => expect(title).toHaveFocus())
      expect(within(dialog).getByRole('textbox', { name: 'Search chats' })).not.toHaveFocus()
    })
  })

  describe('when dismissed', () => {
    it('returns to ☰ on Escape', async () => {
      const { menu } = await openDrawer()

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
      await waitFor(() => expect(menu).toHaveFocus())
    })

    it('returns to ☰ from the built-in close', async () => {
      const { menu, dialog } = await openDrawer()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
      await waitFor(() => expect(menu).toHaveFocus())
    })

    it('returns to the recorded opener when it was not ☰', async () => {
      render(<Harness />)
      const second = screen.getByRole('button', { name: 'Second opener' })
      fireEvent.click(second)
      await screen.findByRole('dialog', { name: 'Menu' })

      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
      await waitFor(() => expect(second).toHaveFocus())
    })

    it('returns to the opener when the drawer is closed from outside (system back)', async () => {
      render(<Harness />)
      const second = screen.getByRole('button', { name: 'Second opener' })
      fireEvent.click(second)
      await screen.findByRole('dialog', { name: 'Menu' })

      // The shell's overlay registration closes it by state, not through Radix.
      fireEvent.click(screen.getByRole('button', { name: 'Close like back', hidden: true }))

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
      await waitFor(() => expect(second).toHaveFocus())
    })

    it('falls back to ☰ when the recorded opener is no longer connected', async () => {
      const controlsRef: MutableRefObject<HarnessControls | null> = { current: null }
      render(<Harness controlsRef={controlsRef} />)
      const menu = screen.getByRole('button', { name: 'Open menu' })
      const temp = screen.getByRole('button', { name: 'Temporary opener' })
      fireEvent.click(temp)
      await screen.findByRole('dialog', { name: 'Menu' })

      act(() => controlsRef.current?.hideTempOpener())
      expect(temp.isConnected).toBe(false)
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
      await waitFor(() => expect(menu).toHaveFocus())
    })
  })

  describe('after a navigation close', () => {
    async function openWithRows() {
      seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }, CHAT_TAB], 'tab-1')
      terminalsRef.current = [{ id: 't1', name: 'zsh' }]
      seedHistory(['Past chat'])
      return openDrawer({
        activeTabId: 'tab-1',
        activeSessionId: 's1',
        onNewTerminal: vi.fn(),
        onOpenGitHistory: vi.fn()
      })
    }

    const NAVIGATIONS: Array<[string, (dialog: HTMLElement) => void]> = [
      [
        'an Open chat row',
        (d) => fireEvent.click(within(d).getByRole('button', { name: 'Chat one' }))
      ],
      ['a terminal row', (d) => fireEvent.click(within(d).getByRole('button', { name: 'zsh' }))],
      [
        'New terminal',
        (d) => fireEvent.click(within(d).getByRole('button', { name: 'New terminal' }))
      ],
      [
        'a History row',
        (d) => fireEvent.click(within(d).getByRole('button', { name: /^Past chat/ }))
      ],
      ['Snapshots', (d) => fireEvent.click(within(d).getByRole('button', { name: 'Snapshots' }))],
      [
        'Git history',
        (d) => fireEvent.click(within(d).getByRole('button', { name: 'Git history' }))
      ]
    ]

    it.each(NAVIGATIONS)('moves focus to #mobile-shell-title after %s', async (_name, tap) => {
      const { dialog } = await openWithRows()

      tap(dialog)

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
      await waitFor(() => expect(document.getElementById('mobile-shell-title')).toHaveFocus())
    })

    it.each(
      NAVIGATIONS
    )('falls back to the opener after %s when there is no title', async (_name, tap) => {
      seedTabs([{ type: 'terminal', id: 'term-t1', terminalId: 't1' }, CHAT_TAB], 'tab-1')
      terminalsRef.current = [{ id: 't1', name: 'zsh' }]
      seedHistory(['Past chat'])
      const { dialog, menu } = await openDrawer({
        withTitle: false,
        activeTabId: 'tab-1',
        activeSessionId: 's1',
        onNewTerminal: vi.fn(),
        onOpenGitHistory: vi.fn()
      })

      tap(dialog)

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
      await waitFor(() => expect(menu).toHaveFocus())
    })
  })

  describe('after a navigation close with a chat pane behind the drawer', () => {
    const tapChatRow = (dialog: HTMLElement): void => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Chat one' }))
    }
    const drawerClosed = (): Promise<void> =>
      waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
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
      await screen.findByRole('dialog', { name: 'Menu' })
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

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
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

      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())
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
    waitFor(() => expect(screen.queryByRole('dialog', { name: 'Menu' })).toBeNull())

  it.each([
    ['☰', 'Open menu', 0],
    ['the attention pill', '2 other chats need you', 2]
  ])('%s: aria-controls resolves to the open Menu dialog', async (_name, label, attentionCount) => {
    render(<HeaderHarness attentionCount={attentionCount} />)
    const control = screen.getByRole('button', { name: label })
    // Closed: the control never references a missing id.
    expect(control).not.toHaveAttribute('aria-controls')

    fireEvent.click(control)

    const dialog = await screen.findByRole('dialog', { name: 'Menu' })
    const controlled = control.getAttribute('aria-controls')
    expect(controlled).toBeTruthy()
    expect(document.getElementById(controlled ?? '')).toBe(dialog)
  })

  it('a navigation then focuses the real header title', async () => {
    render(<HeaderHarness />)
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    const dialog = await screen.findByRole('dialog', { name: 'Menu' })

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
    await screen.findByRole('dialog', { name: 'Menu' })

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await drawerClosed()
    await waitFor(() => expect(pill).toHaveFocus())
  })

  it('falls back to ☰ once the pill is gone', async () => {
    const { rerender } = render(<HeaderHarness attentionCount={2} />)
    const menu = screen.getByRole('button', { name: 'Open menu' })
    const pill = screen.getByRole('button', { name: '2 other chats need you' })
    fireEvent.click(pill)
    await screen.findByRole('dialog', { name: 'Menu' })

    // Nothing needs the user any more: the pill unmounts while the drawer is open.
    rerender(<HeaderHarness attentionCount={0} />)
    expect(pill.isConnected).toBe(false)
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    await drawerClosed()
    await waitFor(() => expect(menu).toHaveFocus())
  })
})
