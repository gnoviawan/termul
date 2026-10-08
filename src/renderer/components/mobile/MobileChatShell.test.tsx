import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileChatShell } from './MobileChatShell'
import type { MobileShellDrawer } from './MobileShellDrawer'

const { projectRef, tauriRef, workspaceRef, drawerPropsRef } = vi.hoisted(() => ({
  // Mutable so individual tests can flip the active project path (the Git
  // Changes header button is disabled when `activeProject.path` is missing)
  // and the shell into web/remote mode (where the project-switcher button +
  // drawer are mounted).
  projectRef: { current: { id: 'p1', name: 'Demo', path: '/demo' } as { path?: string } },
  tauriRef: { current: true as boolean },
  // Mutable workspace state so tests can seed the active tab (terminal, chat).
  workspaceRef: {
    current: {
      leaves: [] as Array<{
        type: 'leaf'
        id: string
        tabs: Array<Record<string, unknown>>
        activeTabId: string | null
      }>,
      activePaneId: 'pane-1'
    }
  },
  // The last props the shell handed to the (stubbed) drawer.
  drawerPropsRef: { current: null as null | ComponentProps<typeof MobileShellDrawer> }
}))

vi.mock('@/stores/project-store', () => ({
  useActiveProject: () => projectRef.current
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
    vi.fn((sel: (s: { terminals: unknown[] }) => unknown) => sel({ terminals: [] })),
    { getState: () => ({ terminals: [] }) }
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

// Stub the drawer so the shell test focuses on the opener wiring and the props
// threaded through (☰ → drawerOpen → `open`; `onOpenChange` closes it). The
// drawer's own layout, focus handling and rows are covered in
// MobileShellDrawer.test.tsx and MobileDrawerOpenSection.test.tsx.
vi.mock('./MobileShellDrawer', () => ({
  MobileShellDrawer: (props: ComponentProps<typeof MobileShellDrawer>) => {
    drawerPropsRef.current = props
    return props.open ? (
      <div>
        <span>shell-drawer</span>
        <button type="button" onClick={() => props.onOpenChange(false)}>
          close-shell-drawer
        </button>
        <button type="button" onClick={props.onOpenProjects}>
          stub-open-projects
        </button>
      </div>
    ) : null
  }
}))

// Stub the project switcher so the shell test focuses on the trigger wiring
// (button → projectsOpen → drawer `open` prop → onOpenChange close). Its own
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

describe('MobileChatShell', () => {
  beforeEach(() => {
    tauriRef.current = true
    projectRef.current = { id: 'p1', name: 'Demo', path: '/demo' }
    drawerPropsRef.current = null
    // Default leaf: one agent-chat tab (the pre-Story-6 drawer shape).
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }], 'tab-1')
  })

  it('gives header actions a 44px hit box (#881)', () => {
    tauriRef.current = false
    render(
      <MobileChatShell
        onNewChat={vi.fn()}
        canNewChat
        onOpenCommandPalette={vi.fn()}
        onOpenGitChanges={vi.fn()}
        onNewProject={vi.fn()}
      >
        <div>chat body</div>
      </MobileChatShell>
    )

    for (const label of [
      'Open menu',
      'Switch project',
      'Browse files',
      'Command palette',
      'New project',
      'Git changes',
      'New chat'
    ]) {
      const button = screen.getByRole('button', { name: label })
      expect(button.className, label).toContain('size-11')
      expect(button.className, label).not.toContain('size-10')
      expect(button.className, label).not.toMatch(/\bh-10\b/)
      expect(button.className, label).not.toMatch(/\bw-10\b/)
    }
  })

  it('renders slim header with title and no desktop chrome markers', () => {
    const { container } = render(
      <MobileChatShell onNewChat={vi.fn()} canNewChat>
        <div>chat body</div>
      </MobileChatShell>
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

  it('invokes onNewChat from the header action', () => {
    const onNewChat = vi.fn()
    render(
      <MobileChatShell onNewChat={onNewChat} canNewChat>
        <div>chat body</div>
      </MobileChatShell>
    )

    fireEvent.click(screen.getByLabelText('New chat'))
    expect(onNewChat).toHaveBeenCalledTimes(1)
  })

  it('invokes onNewProject from the header action, the only in-shell entry once a project exists', () => {
    tauriRef.current = false
    const onNewProject = vi.fn()
    render(
      <MobileChatShell onNewChat={vi.fn()} canNewChat onNewProject={onNewProject}>
        <div>chat body</div>
      </MobileChatShell>
    )

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(onNewProject).toHaveBeenCalledTimes(1)
  })

  describe('drawer opener', () => {
    function renderShell(): void {
      render(
        <MobileChatShell onNewChat={vi.fn()} canNewChat>
          <div>chat body</div>
        </MobileChatShell>
      )
    }

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

    it('records ☰ as the opener and as the fallback target', () => {
      renderShell()
      const menu = screen.getByLabelText('Open menu')

      fireEvent.click(menu)

      expect(drawerProps().returnFocusRef.current).toBe(menu)
      expect(drawerProps().menuButtonRef.current).toBe(menu)
    })

    it('closes the drawer when it calls onOpenChange(false)', () => {
      renderShell()
      fireEvent.click(screen.getByLabelText('Open menu'))

      fireEvent.click(screen.getByText('close-shell-drawer'))

      expect(screen.queryByText('shell-drawer')).not.toBeInTheDocument()
      expect(screen.getByLabelText('Open menu')).toHaveAttribute('aria-expanded', 'false')
      expect(screen.getByLabelText('Open menu')).not.toHaveAttribute('aria-controls')
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
      render(
        <MobileChatShell canNewChat {...handlers}>
          <div>chat body</div>
        </MobileChatShell>
      )

      const props = drawerProps()
      expect(props.activeTabId).toBe('tab-1')
      expect(props.activeSessionId).toBe('s1')
      expect(props.canNewChat).toBe(true)
      expect(props.onNewChat).toBe(handlers.onNewChat)
      expect(props.onNewTerminal).toBe(handlers.onNewTerminal)
      expect(props.onCloseTerminal).toBe(handlers.onCloseTerminal)
      expect(props.onRenameTerminal).toBe(handlers.onRenameTerminal)
      expect(props.onCloseEditorTab).toBe(handlers.onCloseEditorTab)
      expect(props.onOpenGitHistory).toBe(handlers.onOpenGitHistory)
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
      render(
        <MobileChatShell onNewChat={vi.fn()}>
          <div>chat body</div>
        </MobileChatShell>
      )

      expect(drawerProps().canNewChat).toBe(false)
    })
  })

  it('hides the Switch project button in Tauri (desktop) mode', () => {
    tauriRef.current = true
    render(
      <MobileChatShell onNewChat={vi.fn()} canNewChat>
        <div>chat body</div>
      </MobileChatShell>
    )
    // Desktop never mounts the web/remote project drawer — the sidebar owns
    // project switching there. The trigger must not leak into the mobile shell.
    expect(screen.queryByLabelText('Switch project')).not.toBeInTheDocument()
  })

  it('mounts the project drawer trigger in web mode and toggles it open/closed', async () => {
    tauriRef.current = false
    render(
      <MobileChatShell onNewChat={vi.fn()} canNewChat>
        <div>chat body</div>
      </MobileChatShell>
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
      <MobileChatShell onNewChat={vi.fn()} canNewChat>
        <div>chat body</div>
      </MobileChatShell>
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
      <MobileChatShell onNewChat={vi.fn()} canNewChat>
        <div>chat body</div>
      </MobileChatShell>
    )
    // Desktop never mounts the web/remote file explorer — the right-sidebar
    // FileExplorer owns file browsing there.
    expect(screen.queryByLabelText('Browse files')).not.toBeInTheDocument()
  })

  it('hides the Command palette button in Tauri (desktop) mode', () => {
    tauriRef.current = true
    render(
      <MobileChatShell onNewChat={vi.fn()} canNewChat onOpenCommandPalette={vi.fn()}>
        <div>chat body</div>
      </MobileChatShell>
    )
    expect(screen.queryByLabelText('Command palette')).not.toBeInTheDocument()
  })

  it('mounts the Command palette trigger in web mode and invokes onOpenCommandPalette', () => {
    tauriRef.current = false
    const onOpenCommandPalette = vi.fn()
    render(
      <MobileChatShell onNewChat={vi.fn()} canNewChat onOpenCommandPalette={onOpenCommandPalette}>
        <div>chat body</div>
      </MobileChatShell>
    )

    const btn = screen.getByLabelText('Command palette')
    fireEvent.click(btn)
    expect(onOpenCommandPalette).toHaveBeenCalledTimes(1)
  })

  it('hides the Git changes button in Tauri (desktop) mode', () => {
    tauriRef.current = true
    render(
      <MobileChatShell onNewChat={vi.fn()} canNewChat onOpenGitChanges={vi.fn()}>
        <div>chat body</div>
      </MobileChatShell>
    )
    expect(screen.queryByLabelText('Git changes')).not.toBeInTheDocument()
  })

  it('mounts the Git changes trigger in web mode and invokes onOpenGitChanges', () => {
    tauriRef.current = false
    const onOpenGitChanges = vi.fn()
    render(
      <MobileChatShell onNewChat={vi.fn()} canNewChat onOpenGitChanges={onOpenGitChanges}>
        <div>chat body</div>
      </MobileChatShell>
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
      <MobileChatShell onNewChat={vi.fn()} canNewChat onOpenGitChanges={vi.fn()}>
        <div>chat body</div>
      </MobileChatShell>
    )

    expect(screen.getByLabelText('Git changes')).toBeDisabled()
  })

  // ── Story 11 (QA F9): header title never collapses to ~0 width ──────────

  it('guarantees the header title a min width with all web-mode actions and an active terminal', () => {
    // The worst case: web mode (project/files/palette/new-project/git buttons
    // all mounted) + a terminal tab (restart/close pair) — 7 shrink-0
    // buttons. The title column must still reserve a minimum width so the
    // Web mode mounts every header action (Tauri hides the web-only ones).
    tauriRef.current = false
    seedTabs(
      [
        { type: 'terminal', id: 'term-t1', terminalId: 't1' },
        { type: 'agent-chat', id: 'tab-1', sessionId: 's1' }
      ],
      'term-t1'
    )
    render(
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
