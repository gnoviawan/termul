import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileChatShell } from './MobileChatShell'

const {
  mockNavigate,
  projectRef,
  tauriRef,
  workspaceRef,
  editorRef,
  mockRemoveBrowserTab,
  browserTabsRef
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  // Mutable so individual tests can flip the active project path (the Git
  // Changes header button is disabled when `activeProject.path` is missing)
  // and the shell into web/remote mode (where the project-switcher button +
  // drawer are mounted).
  projectRef: { current: { id: 'p1', name: 'Demo', path: '/demo' } as { path?: string } },
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
      removeTab: vi.fn(),
      setActiveTab: vi.fn()
    }
  },
  editorRef: {
    current: {
      openFiles: new Map<string, { isDirty: boolean }>()
    }
  },
  mockRemoveBrowserTab: vi.fn(),
  browserTabsRef: { current: new Map<string, unknown>() }
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate
  }
})

vi.mock('@/stores/project-store', () => ({
  useActiveProject: () => projectRef.current
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
    vi.fn((sel: (s: { terminals: unknown[] }) => unknown) => sel({ terminals: [] })),
    { getState: () => ({ terminals: [] }) }
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

vi.mock('@/stores/overlay-stack-store', () => ({
  useOverlayRegistration: () => undefined
}))

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (
    sel: (s: {
      sessions: Record<string, { title: string }>
      sessionIndex: Array<{ id: string; title: string }>
    }) => unknown
  ) => sel({ sessions: { s1: { title: 'Hello chat' } }, sessionIndex: [] })
}))

vi.mock('@/components/chat/ChatHistoryTab', () => ({
  ChatHistoryTab: ({ onSessionOpened }: { onSessionOpened?: () => void }) => (
    <button type="button" onClick={() => onSessionOpened?.()}>
      Open history chat
    </button>
  )
}))

// Stub the drawer so the shell test focuses on the trigger wiring (button →
// projectsOpen → drawer `open` prop → onOpenChange close). The drawer's own
// open/close + state rendering is covered in ProjectSwitcherDrawer.test.tsx.
vi.mock('@/components/chat/ProjectSwitcherDrawer', () => ({
  ProjectSwitcherDrawer: ({
    open,
    onOpenChange
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div>
        <span>project-drawer</span>
        <button type="button" onClick={() => onOpenChange(false)}>
          close-drawer
        </button>
      </div>
    ) : null
}))

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

describe('MobileChatShell', () => {
  beforeEach(() => {
    mockNavigate.mockReset()
    mockRemoveBrowserTab.mockReset()
    workspaceRef.current.removeTab.mockReset()
    workspaceRef.current.setActiveTab.mockReset()
    tauriRef.current = true
    projectRef.current = { id: 'p1', name: 'Demo', path: '/demo' }
    // Default leaf: one agent-chat tab (the pre-Story-6 drawer shape).
    workspaceRef.current = {
      ...workspaceRef.current,
      leaves: [
        {
          type: 'leaf',
          id: 'pane-1',
          tabs: [{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }],
          activeTabId: 'tab-1'
        }
      ],
      activePaneId: 'pane-1'
    }
    editorRef.current.openFiles = new Map()
    browserTabsRef.current = new Map()
  })

  it('renders slim header with title and no desktop chrome markers', () => {
    const { container } = render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

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

  it('opens the chat drawer and closes it after selecting a session', async () => {
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByLabelText('Open menu'))
    expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText('Open history chat')).toBeInTheDocument()
    expect(screen.getByText('New chat')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Open history chat'))
    expect(screen.queryByText('Open history chat')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'false')
  })

  it('invokes onNewChat from the header action', () => {
    const onNewChat = vi.fn()
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={onNewChat} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByLabelText('New chat'))
    expect(onNewChat).toHaveBeenCalledTimes(1)
  })

  it('hides the Switch project button in Tauri (desktop) mode', () => {
    tauriRef.current = true
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )
    // Desktop never mounts the web/remote project drawer — the sidebar owns
    // project switching there. The trigger must not leak into the mobile shell.
    expect(screen.queryByLabelText('Switch project')).not.toBeInTheDocument()
  })

  it('mounts the project drawer trigger in web mode and toggles it open/closed', async () => {
    tauriRef.current = false
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    const switchBtn = screen.getByLabelText('Switch project')
    expect(switchBtn).toBeInTheDocument()
    // Drawer starts closed.
    expect(screen.queryByText('project-drawer')).not.toBeInTheDocument()

    fireEvent.click(switchBtn)
    expect(await screen.findByText('project-drawer')).toBeInTheDocument()

    // Closing via the drawer's onOpenChange(false) unmounts its content.
    fireEvent.click(screen.getByText('close-drawer'))
    expect(screen.queryByText('project-drawer')).not.toBeInTheDocument()
  })

  it('mounts the files drawer trigger in web mode and toggles it open/closed', async () => {
    tauriRef.current = false
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    const filesBtn = screen.getByLabelText('Browse files')
    expect(filesBtn).toBeInTheDocument()
    // Drawer starts closed.
    expect(screen.queryByText('files-drawer')).not.toBeInTheDocument()

    fireEvent.click(filesBtn)
    expect(await screen.findByText('files-drawer')).toBeInTheDocument()

    // Closing via the drawer's onOpenChange(false) unmounts its content.
    fireEvent.click(screen.getByText('close-files'))
    expect(screen.queryByText('files-drawer')).not.toBeInTheDocument()
  })

  it('hides the Browse files button in Tauri (desktop) mode', () => {
    tauriRef.current = true
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )
    // Desktop never mounts the web/remote file explorer — the right-sidebar
    // FileExplorer owns file browsing there.
    expect(screen.queryByLabelText('Browse files')).not.toBeInTheDocument()
  })

  it('hides the Command palette button in Tauri (desktop) mode', () => {
    tauriRef.current = true
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat onOpenCommandPalette={vi.fn()}>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )
    expect(screen.queryByLabelText('Command palette')).not.toBeInTheDocument()
  })

  it('mounts the Command palette trigger in web mode and invokes onOpenCommandPalette', () => {
    tauriRef.current = false
    const onOpenCommandPalette = vi.fn()
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat onOpenCommandPalette={onOpenCommandPalette}>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    const btn = screen.getByLabelText('Command palette')
    fireEvent.click(btn)
    expect(onOpenCommandPalette).toHaveBeenCalledTimes(1)
  })

  it('hides the Git changes button in Tauri (desktop) mode', () => {
    tauriRef.current = true
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat onOpenGitChanges={vi.fn()}>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )
    expect(screen.queryByLabelText('Git changes')).not.toBeInTheDocument()
  })

  it('mounts the Git changes trigger in web mode and invokes onOpenGitChanges', () => {
    tauriRef.current = false
    const onOpenGitChanges = vi.fn()
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat onOpenGitChanges={onOpenGitChanges}>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    const btn = screen.getByLabelText('Git changes')
    expect(btn).not.toBeDisabled()
    fireEvent.click(btn)
    expect(onOpenGitChanges).toHaveBeenCalledTimes(1)
  })

  it('disables the Git changes button when no active project path', () => {
    tauriRef.current = false
    projectRef.current = { id: 'p1', name: 'Demo' }
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat onOpenGitChanges={vi.fn()}>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    expect(screen.getByLabelText('Git changes')).toBeDisabled()
  })

  it('navigates to /snapshots from the drawer', () => {
    tauriRef.current = false
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByLabelText('Snapshots'))
    expect(mockNavigate).toHaveBeenCalledWith('/snapshots')
    // The drawer closes after navigating.
    expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'false')
  })

  it('hides the Git history button in Tauri (desktop) mode', () => {
    tauriRef.current = true
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat onOpenGitHistory={vi.fn()}>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )
    // Desktop never shows the mobile Git History entry (the ActivityRail owns
    // it there). The drawer button must not leak into the mobile shell.
    fireEvent.click(screen.getByLabelText('Open menu'))
    expect(screen.queryByLabelText('Git history')).not.toBeInTheDocument()
  })

  it('mounts the Git history trigger in web mode and invokes onOpenGitHistory', () => {
    tauriRef.current = false
    const onOpenGitHistory = vi.fn()
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat onOpenGitHistory={onOpenGitHistory}>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

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
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat onOpenGitHistory={vi.fn()}>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByLabelText('Open menu'))
    expect(screen.getByLabelText('Git history')).toBeDisabled()
  })

  // ── Story 6: drawer lists ALL pane tabs (QA F3 navigation traps) ─────────

  function seedAllTabTypes(): void {
    workspaceRef.current = {
      ...workspaceRef.current,
      leaves: [
        {
          type: 'leaf',
          id: 'pane-1',
          tabs: [
            { type: 'terminal', id: 'term-t1', terminalId: 't1' },
            { type: 'editor', id: 'edit-/proj/a.ts', filePath: '/proj/a.ts' },
            { type: 'git', id: 'git-/proj', cwd: '/proj' },
            { type: 'git-history', id: 'git-history-/proj', cwd: '/proj' },
            { type: 'browser', id: 'browser-b1', browserTabId: 'b1' },
            { type: 'agent-chat', id: 'tab-1', sessionId: 's1' }
          ],
          activeTabId: 'tab-1'
        }
      ],
      activePaneId: 'pane-1'
    }
    browserTabsRef.current = new Map([
      ['b1', { id: 'b1', url: 'https://example.com/page', title: 'Example Site' }]
    ])
  }

  it('drawer lists every non-terminal pane tab with a close affordance', () => {
    seedAllTabTypes()
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

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
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByLabelText('Open menu'))
    expect(screen.getByTestId('editor-dirty-dot')).toBeInTheDocument()
  })

  it('drawer omits the editor dirty dot when the file is clean', () => {
    seedAllTabTypes()
    editorRef.current.openFiles = new Map([['/proj/a.ts', { isDirty: false }]])
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByLabelText('Open menu'))
    expect(screen.queryByTestId('editor-dirty-dot')).not.toBeInTheDocument()
  })

  it('drawer close on a dirty editor tab routes through the dirty guard, not removeTab', () => {
    seedAllTabTypes()
    const onCloseEditorTab = vi.fn()
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat onCloseEditorTab={onCloseEditorTab}>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))

    expect(onCloseEditorTab).toHaveBeenCalledWith('/proj/a.ts')
    expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()
  })

  it('drawer close on a terminal tab routes through the existing terminal close flow', () => {
    seedAllTabTypes()
    const onCloseTerminal = vi.fn()
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat onCloseTerminal={onCloseTerminal}>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByLabelText('Open menu'))
    // The terminal-store mock has no terminal records, so the row label
    // falls back to the plain "terminal" display name.
    fireEvent.click(screen.getByRole('button', { name: 'Close terminal' }))

    expect(onCloseTerminal).toHaveBeenCalledWith('t1', 'term-t1')
    expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()
  })

  it('drawer close on git and git-history tabs removes the tab directly', () => {
    seedAllTabTypes()
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByRole('button', { name: 'Close git changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close git history' }))

    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('git-/proj')
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('git-history-/proj')
  })

  it('drawer close on a browser tab tears down the session tab and the workspace tab', () => {
    seedAllTabTypes()
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByRole('button', { name: 'Close Example Site' }))

    expect(mockRemoveBrowserTab).toHaveBeenCalledWith('b1')
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('browser-b1')
  })

  it('drawer close on an agent-chat tab removes the tab directly', () => {
    seedAllTabTypes()
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByRole('button', { name: 'Close Hello chat' }))

    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('tab-1')
  })

  it('drawer close on an editor tab falls back to removeTab when no guard is threaded', () => {
    seedAllTabTypes()
    render(
      <MemoryRouter>
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    fireEvent.click(screen.getByLabelText('Open menu'))
    fireEvent.click(screen.getByRole('button', { name: 'Close a.ts' }))

    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('edit-/proj/a.ts')
  })

  // ── Story 11 (QA F9): header title never collapses to ~0 width ──────────

  it('guarantees the header title a min width with all web-mode actions and an active terminal', () => {
    // The worst case: web mode (project/files/palette/new-project/git buttons
    // all mounted) + a terminal tab (restart/close pair) — 7 shrink-0
    // buttons. The title column must still reserve a minimum width so the
    // Web mode mounts every header action (Tauri hides the web-only ones).
    tauriRef.current = false
    seedAllTabTypes()
    workspaceRef.current.leaves[0].activeTabId = 'term-t1'
    render(
      <MemoryRouter>
        <MobileChatShell
          onNewChat={vi.fn()}
          canNewChat
          onOpenCommandPalette={vi.fn()}
          onOpenGitChanges={vi.fn()}
          onNewProject={vi.fn()}
          onRestartTerminal={vi.fn()}
          onCloseTerminal={vi.fn()}
        >
          <div>chat body</div>
        </MobileChatShell>
      </MemoryRouter>
    )

    const titleColumn = document.querySelector('[data-mobile-header-title]')
    expect(titleColumn).not.toBeNull()
    // min-w-16 (64px) is the guaranteed floor; flex-1 lets it grow.
    expect(titleColumn?.className).toContain('min-w-16')
    expect(titleColumn?.className).toContain('flex-1')
    // The trailing actions live in one shrinkable cluster, not beside the
    // title as 7 independent flex siblings.
    expect(titleColumn?.nextElementSibling?.className).toContain('shrink')
    // Every web-mode action still renders.
    expect(screen.getByLabelText('Switch project')).toBeInTheDocument()
    expect(screen.getByLabelText('Close terminal')).toBeInTheDocument()
  })
})
