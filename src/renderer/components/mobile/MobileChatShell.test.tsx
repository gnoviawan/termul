import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileChatShell } from './MobileChatShell'

const { mockNavigate, projectRef, tauriRef } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  // Mutable so individual tests can flip the active project path (the Git
  // Changes header button is disabled when `activeProject.path` is missing)
  // and the shell into web/remote mode (where the project-switcher button +
  // drawer are mounted).
  projectRef: { current: { id: 'p1', name: 'Demo', path: '/demo' } as { path?: string } },
  tauriRef: { current: true as boolean }
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
  getAllLeafPanes: () => [
    {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }],
      activeTabId: 'tab-1'
    }
  ],
  useWorkspaceStore: (sel: (s: { root: unknown; activePaneId: string }) => unknown) =>
    sel({ root: {}, activePaneId: 'pane-1' })
}))

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (
    sel: (s: { sessions: Record<string, { title: string }>; sessionIndex: unknown[] }) => unknown
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
    tauriRef.current = true
    projectRef.current = { id: 'p1', name: 'Demo', path: '/demo' }
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
})
