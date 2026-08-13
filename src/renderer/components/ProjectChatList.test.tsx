import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionIndexEntry } from '@/lib/acp-history-persistence'
import { useAcpStore } from '@/stores/acp-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { ProjectChatList } from './ProjectChatList'

const {
  mockOpenTerminalAtCwd,
  mockAddAgentChatTab,
  mockOpenHistorySession,
  mockDeleteHistorySession,
  mockClipboardWriteText,
  mockRevealInFileManager,
  mockToastSuccess,
  mockToastError
} = vi.hoisted(() => ({
  mockOpenTerminalAtCwd: vi.fn(),
  mockAddAgentChatTab: vi.fn(),
  mockOpenHistorySession: vi.fn(),
  mockDeleteHistorySession: vi.fn(),
  mockClipboardWriteText: vi.fn(),
  mockRevealInFileManager: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn()
}))

vi.mock('@/lib/terminal-spawn', () => ({
  openTerminalAtCwd: mockOpenTerminalAtCwd
}))

vi.mock('@/lib/api', () => ({
  clipboardApi: { writeText: mockClipboardWriteText },
  openerApi: { revealInFileManager: mockRevealInFileManager }
}))

vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError }
}))

// Stub the Radix context-menu primitives. The chat list renders one menu per
// row; the stateful stub opens the menu on `contextmenu` (only if the child's
// onContextMenu did not call preventDefault — mirrors Radix's
// composeEventHandlers({ checkForDefaultPrevented: true }) so F1-type
// regressions surface), renders `<ContextMenuContent>` only while open, closes
// on Escape, and surfaces `<ContextMenuItem>` as a `<button>` so the existing
// tests can `getByText(...).closest('button')` and assert disabled state +
// click wiring. Mirrors the ProjectSidebar / WorkspaceTabBar stub pattern.
vi.mock('@/components/ui/context-menu', async () => {
  const React = await import('react')
  const MenuCtx = React.createContext<{ open: boolean; setOpen: (o: boolean) => void }>({
    open: false,
    setOpen: () => {}
  })
  return {
    ContextMenu: ({ children }: { children: React.ReactNode }) => {
      const [open, setOpen] = React.useState(false)
      React.useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
          if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open])
      return <MenuCtx.Provider value={{ open, setOpen }}>{children}</MenuCtx.Provider>
    },
    ContextMenuTrigger: ({
      children,
      asChild
    }: {
      children: React.ReactNode
      asChild?: boolean
    }) => {
      const { setOpen } = React.useContext(MenuCtx)
      const merged = (e: React.MouseEvent) => {
        // F2: mirror Radix checkForDefaultPrevented — skip open if the child
        // handler called preventDefault.
        if (e.defaultPrevented) return
        e.preventDefault()
        setOpen(true)
      }
      if (asChild && React.isValidElement(children)) {
        const child = children as React.ReactElement<{
          onContextMenu?: (e: React.MouseEvent) => void
        }>
        return React.cloneElement(child, {
          onContextMenu: (e: React.MouseEvent) => {
            child.props.onContextMenu?.(e)
            merged(e)
          }
        })
      }
      return <div onContextMenu={merged}>{children}</div>
    },
    ContextMenuContent: ({ children }: { children: React.ReactNode }) => {
      const { open } = React.useContext(MenuCtx)
      if (!open) return null
      return <div>{children}</div>
    },
    ContextMenuItem: ({
      children,
      disabled,
      onSelect,
      variant
    }: {
      children: React.ReactNode
      disabled?: boolean
      onSelect?: () => void
      variant?: 'default' | 'destructive'
    }) => (
      <button
        type="button"
        disabled={disabled}
        data-variant={variant}
        onClick={() => {
          if (!disabled) onSelect?.()
        }}
      >
        {children}
      </button>
    ),
    ContextMenuSeparator: () => <hr />
  }
})

beforeEach(() => {
  mockOpenTerminalAtCwd.mockReset()
  mockOpenTerminalAtCwd.mockResolvedValue({ status: 'opened', terminalId: 'term-1' })
  mockAddAgentChatTab.mockReset()
  mockOpenHistorySession.mockReset()
  mockOpenHistorySession.mockResolvedValue(undefined)
  mockDeleteHistorySession.mockReset()
  mockDeleteHistorySession.mockResolvedValue(undefined)
  mockClipboardWriteText.mockReset()
  mockClipboardWriteText.mockResolvedValue({ success: true })
  mockRevealInFileManager.mockReset()
  mockRevealInFileManager.mockResolvedValue({ success: true })
  mockToastSuccess.mockReset()
  mockToastError.mockReset()
  useAcpStore.setState({
    sessionIndex: [],
    openHistorySession: mockOpenHistorySession,
    deleteHistorySession: mockDeleteHistorySession
  })
  useWorkspaceStore.setState({
    activePaneId: 'pane-1',
    addAgentChatTab: mockAddAgentChatTab
  })
})

const entry = (overrides: Partial<SessionIndexEntry> = {}): SessionIndexEntry => ({
  id: 'c1',
  agentId: 'agent-1',
  title: 'First chat',
  cwd: '/repo/main',
  projectId: 'p1',
  createdAt: 1000,
  lastActivityAt: 2000,
  messageCount: 3,
  status: 'active',
  ...overrides
})

/** Count rendered chat rows via the per-row "Open terminal for chat …" affordance. */
const chatRows = () => screen.getAllByRole('button', { name: /^Open terminal for chat / })

describe('ProjectChatList scoping', () => {
  it('scopes by projectId only, excludes discovered sessions, newest-first', () => {
    useAcpStore.setState({
      sessionIndex: [
        entry({ id: 'old', title: 'Older', projectId: 'p1', lastActivityAt: 1000 }),
        entry({ id: 'other', title: 'Other Project', projectId: 'p2', lastActivityAt: 9000 }),
        entry({
          id: 'disc',
          title: 'Discovered',
          projectId: 'p1',
          lastActivityAt: 8000,
          discovered: true
        }),
        entry({ id: 'new', title: 'Newest', projectId: 'p1', lastActivityAt: 5000 })
      ]
    })
    render(<ProjectChatList projectId="p1" />)

    // Only the two p1, non-discovered chats render.
    expect(chatRows()).toHaveLength(2)
    expect(screen.getByText('Newest')).toBeInTheDocument()
    expect(screen.getByText('Older')).toBeInTheDocument()
    expect(screen.queryByText('Other Project')).not.toBeInTheDocument()
    expect(screen.queryByText('Discovered')).not.toBeInTheDocument()

    // Newest-first: Newest's terminal button precedes Older's in DOM order.
    const newestBtn = screen.getByLabelText('Open terminal for chat Newest')
    const olderBtn = screen.getByLabelText('Open terminal for chat Older')
    expect(newestBtn.compareDocumentPosition(olderBtn)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('still lists a drifted-cwd chat (projectId match) and opens a terminal there', async () => {
    // cwd does not match any stored worktree path, but the chat is reachable by projectId.
    useAcpStore.setState({
      sessionIndex: [entry({ id: 'drift', title: 'Drifted', cwd: '/somewhere/else' })]
    })
    render(<ProjectChatList projectId="p1" />)

    expect(screen.getByText('Drifted')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Open terminal for chat Drifted'))
    await waitFor(() => {
      expect(mockOpenTerminalAtCwd).toHaveBeenCalledWith('p1', '/somewhere/else')
    })
  })
})

describe('ProjectChatList empty / search states', () => {
  it('shows the empty state when the project has no chats', () => {
    render(<ProjectChatList projectId="p1" />)
    expect(
      screen.getByText('No chats yet. Start one with the New Chat button.')
    ).toBeInTheDocument()
  })

  it('filters chats by title (case-insensitive) and shows "No matches." when nothing matches', () => {
    useAcpStore.setState({
      sessionIndex: [
        entry({ id: 'a', title: 'Refactor Auth', lastActivityAt: 1000 }),
        entry({ id: 'b', title: 'Add Tests', lastActivityAt: 2000 })
      ]
    })
    render(<ProjectChatList projectId="p1" />)

    fireEvent.change(screen.getByLabelText('Search chats'), {
      target: { value: 'AUTH' }
    })
    expect(screen.getByText('Refactor Auth')).toBeInTheDocument()
    expect(screen.queryByText('Add Tests')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search chats'), {
      target: { value: 'zzzz' }
    })
    expect(screen.getByText('No matches.')).toBeInTheDocument()
  })
})

describe('ProjectChatList pagination', () => {
  it('renders at most 10 rows initially and lazy-loads the next page via the sentinel', () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      entry({
        id: `c${i}`,
        title: `Chat ${i}`,
        lastActivityAt: 1000 + i
      })
    )
    useAcpStore.setState({ sessionIndex: many })
    render(<ProjectChatList projectId="p1" />)

    // Hard cap: only 10 rows render initially.
    expect(chatRows()).toHaveLength(10)
    // The newest 10 (14..5) render; the oldest 5 (4..0) do not yet.
    expect(screen.getByText('Chat 14')).toBeInTheDocument()
    expect(screen.queryByText('Chat 0')).not.toBeInTheDocument()

    // The IntersectionObserver is a no-op in jsdom; the "Load more" button
    // mirrors the same growth (same pattern as ChatHistoryTab).
    fireEvent.click(screen.getByText(/Load more/))
    expect(chatRows()).toHaveLength(15)
    expect(screen.getByText('Chat 0')).toBeInTheDocument()
  })
})

describe('ProjectChatList chat row interactions', () => {
  it('opens/resumes the chat when the row is clicked (no active-worktree sync)', async () => {
    useAcpStore.setState({ sessionIndex: [entry({ id: 'c1', title: 'My Chat' })] })
    render(<ProjectChatList projectId="p1" />)

    fireEvent.click(screen.getByText('My Chat'))

    await waitFor(() => {
      expect(mockOpenHistorySession).toHaveBeenCalledWith('c1')
      expect(mockAddAgentChatTab).toHaveBeenCalledWith('c1')
    })
    // Row click must not route through the worktree spawn path (which syncs
    // activeWorktreeId).
    expect(mockOpenTerminalAtCwd).not.toHaveBeenCalled()
  })

  it('shows a toast.error when opening a chat fails (reopen rejection)', async () => {
    mockOpenHistorySession.mockRejectedValue(new Error('boom'))
    useAcpStore.setState({ sessionIndex: [entry({ id: 'c1', title: 'My Chat' })] })
    render(<ProjectChatList projectId="p1" />)

    fireEvent.click(screen.getByText('My Chat'))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Could not open that chat. Try again.')
    })
  })

  it('opens a terminal at the chat cwd via openTerminalAtCwd when the terminal icon is clicked', async () => {
    useAcpStore.setState({
      sessionIndex: [entry({ id: 'c1', title: 'My Chat', cwd: '/repo/wt' })]
    })
    render(<ProjectChatList projectId="p1" />)

    fireEvent.click(screen.getByLabelText('Open terminal for chat My Chat'))

    await waitFor(() => {
      expect(mockOpenTerminalAtCwd).toHaveBeenCalledWith('p1', '/repo/wt')
    })
  })

  it('disables the terminal icon when the chat has no cwd', () => {
    useAcpStore.setState({
      sessionIndex: [entry({ id: 'c1', title: 'No Cwd', cwd: '' })]
    })
    render(<ProjectChatList projectId="p1" />)

    const termBtn = screen.getByLabelText('Open terminal for chat No Cwd')
    expect(termBtn).toBeDisabled()
    expect(termBtn).toHaveAttribute('title', 'No working directory for this chat')
  })
})

describe('ProjectChatList context menu', () => {
  beforeEach(() => {
    useAcpStore.setState({
      sessionIndex: [entry({ id: 'c1', title: 'Ctx Chat', cwd: '/repo/x' })]
    })
  })

  it('offers Open Terminal Here / Open in File Explorer / Copy Path / Delete Chat', () => {
    render(<ProjectChatList projectId="p1" />)
    fireEvent.contextMenu(screen.getByText('Ctx Chat'))

    expect(screen.getByText('Open Terminal Here')).toBeInTheDocument()
    expect(screen.getByText('Open in File Explorer')).toBeInTheDocument()
    expect(screen.getByText('Copy Path')).toBeInTheDocument()
    expect(screen.getByText('Delete Chat')).toBeInTheDocument()
  })

  it('runs Open Terminal Here against the chat cwd', async () => {
    render(<ProjectChatList projectId="p1" />)
    fireEvent.contextMenu(screen.getByText('Ctx Chat'))
    fireEvent.click(screen.getByText('Open Terminal Here'))

    await waitFor(() => expect(mockOpenTerminalAtCwd).toHaveBeenCalledWith('p1', '/repo/x'))
  })

  it('runs Copy Path against the chat cwd', async () => {
    render(<ProjectChatList projectId="p1" />)
    fireEvent.contextMenu(screen.getByText('Ctx Chat'))
    fireEvent.click(screen.getByText('Copy Path'))

    await waitFor(() => expect(mockClipboardWriteText).toHaveBeenCalledWith('/repo/x'))
  })

  it('runs Open in File Explorer against the chat cwd', async () => {
    render(<ProjectChatList projectId="p1" />)
    fireEvent.contextMenu(screen.getByText('Ctx Chat'))
    fireEvent.click(screen.getByText('Open in File Explorer'))

    await waitFor(() => expect(mockRevealInFileManager).toHaveBeenCalledWith('/repo/x'))
  })

  it('requires confirmation before deleting a chat, then deletes on confirm', async () => {
    render(<ProjectChatList projectId="p1" />)
    fireEvent.contextMenu(screen.getByText('Ctx Chat'))
    fireEvent.click(screen.getByText('Delete Chat'))

    // A confirmation dialog blocks the irreversible delete.
    expect(screen.getByText('Delete chat')).toBeInTheDocument()
    // No deletion yet — only after the user confirms.
    expect(mockDeleteHistorySession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(mockDeleteHistorySession).toHaveBeenCalledWith('c1'))
  })

  it('does not delete when the confirmation dialog is cancelled', () => {
    render(<ProjectChatList projectId="p1" />)
    fireEvent.contextMenu(screen.getByText('Ctx Chat'))
    fireEvent.click(screen.getByText('Delete Chat'))
    // Cancel the confirmation — the chat must not be deleted.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(mockDeleteHistorySession).not.toHaveBeenCalled()
  })

  it('shows a toast.error when deleting a chat fails (rejection)', async () => {
    mockDeleteHistorySession.mockRejectedValue(new Error('boom'))
    render(<ProjectChatList projectId="p1" />)
    fireEvent.contextMenu(screen.getByText('Ctx Chat'))
    fireEvent.click(screen.getByText('Delete Chat'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Could not delete that chat. Try again.')
    })
  })

  it('disables cwd-dependent context actions when the chat has no cwd', () => {
    useAcpStore.setState({
      sessionIndex: [entry({ id: 'c2', title: 'No Cwd', cwd: '' })]
    })
    render(<ProjectChatList projectId="p1" />)
    fireEvent.contextMenu(screen.getByText('No Cwd'))

    expect(screen.getByText('Open Terminal Here').closest('button')).toBeDisabled()
    expect(screen.getByText('Open in File Explorer').closest('button')).toBeDisabled()
    expect(screen.getByText('Copy Path').closest('button')).toBeDisabled()
  })
})
