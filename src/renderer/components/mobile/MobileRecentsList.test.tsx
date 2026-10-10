import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockSessionIndexEntry } from '@/lib/test-utils/acp'
import { _resetEphemeralSessionIdsForTesting, useAcpStore } from '@/stores/acp-store'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'
import { useProjectStore } from '@/stores/project-store'
import { MobileRecentsList } from './MobileRecentsList'

const { workspaceRef, mockRequestCloseAgentChat, mockAddAgentChatTab, mockNavigate } = vi.hoisted(
  () => ({
    mockNavigate: vi.fn(),
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
    mockRequestCloseAgentChat: vi.fn(),
    mockAddAgentChatTab: vi.fn()
  })
)

vi.mock('@/stores/workspace-store', () => ({
  getAllLeafPanes: () => workspaceRef.current.leaves,
  useWorkspaceStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) =>
      sel({
        root: { leaves: workspaceRef.current.leaves },
        activePaneId: workspaceRef.current.activePaneId,
        addAgentChatTab: mockAddAgentChatTab
      })
    ),
    { getState: () => workspaceRef.current }
  )
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('@/hooks/use-agent-idle-shutdown', () => ({
  requestCloseAgentChat: mockRequestCloseAgentChat
}))

const onNavigate = vi.fn()
const mockOpenHistorySession = vi.fn()
const mockDeleteHistorySession = vi.fn()

function seedTabs(tabs: Array<Record<string, unknown>>, activeTabId: string | null = null): void {
  workspaceRef.current = {
    ...workspaceRef.current,
    leaves: [{ type: 'leaf', id: 'pane-1', tabs, activeTabId }],
    activePaneId: 'pane-1'
  }
}

function seedHistory(entries: Array<{ id: string; title: string; ageMs?: number }>): void {
  useAcpStore.setState({
    sessionIndex: entries.map(({ id, title, ageMs = 0 }) =>
      mockSessionIndexEntry({
        id,
        title,
        projectId: 'p1',
        cwd: '/work',
        status: 'active',
        lastActivityAt: Date.now() - ageMs
      })
    ),
    openHistorySession: mockOpenHistorySession,
    deleteHistorySession: mockDeleteHistorySession
  })
}

function renderList(props: Partial<ComponentProps<typeof MobileRecentsList>> = {}, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <h2 id="recents-heading" tabIndex={-1}>
        Recents
      </h2>
      <div style={{ width: 390 }}>
        <MobileRecentsList
          query=""
          headingId="recents-heading"
          activeTabId={null}
          onNavigate={onNavigate}
          {...props}
        />
      </div>
    </MemoryRouter>
  )
}

const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  onNavigate.mockReset()
  mockNavigate.mockReset()
  mockAddAgentChatTab.mockReset()
  mockOpenHistorySession.mockReset().mockResolvedValue(undefined)
  mockDeleteHistorySession.mockReset().mockResolvedValue(undefined)
  mockRequestCloseAgentChat
    .mockReset()
    .mockImplementation((_id: string, closeTab: () => void) => closeTab())
  workspaceRef.current.removeTab.mockReset()
  workspaceRef.current.setActiveTab.mockReset()
  workspaceRef.current.fullscreenPaneId = null
  useAcpStore.setState(FRESH)
  _resetEphemeralSessionIdsForTesting()
  useAgentChatLifetimeStore.setState({ closingSessionIds: {} })
  useAgentChatUnreadStore.setState({ unread: {} })
  useProjectStore.setState({
    projects: [
      {
        id: 'p1',
        name: 'termul',
        color: 'blue',
        path: '/work',
        gitBranch: 'main',
        isGitRepo: true,
        worktrees: [],
        activeWorktreeId: null
      }
    ],
    activeProjectId: 'p1'
  })
  seedTabs([])
})

describe('MobileRecentsList merged list', () => {
  it('groups chats into Today, Yesterday and Earlier', () => {
    seedHistory([
      { id: 'a', title: 'Today chat' },
      { id: 'b', title: 'Yesterday chat', ageMs: DAY },
      { id: 'c', title: 'Old chat', ageMs: 10 * DAY }
    ])
    renderList()

    for (const [group, title] of [
      ['Today', 'Today chat'],
      ['Yesterday', 'Yesterday chat'],
      ['Earlier', 'Old chat']
    ]) {
      expect(within(screen.getByRole('group', { name: group })).getByText(title)).toBeTruthy()
    }
  })

  it('lists an open chat that is also in the index once, with its live status, highlighted when active', () => {
    seedHistory([
      { id: 's1', title: 'Index title' },
      { id: 'h2', title: 'Past chat', ageMs: 10 }
    ])
    seedOptionsSession('s1', 'agent-1', { title: 'Live title', activeTurn: true, openTurnId: 't1' })
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }], 'tab-1')
    renderList({ activeTabId: 'tab-1' })

    const rows = document.querySelectorAll('[data-recents-entry-id="s1"]')
    expect(rows).toHaveLength(1)
    const row = screen.getByRole('button', { name: 'Live title, Working' })
    expect(row).toHaveAttribute('aria-current', 'page')
    expect(row).toHaveClass('rounded-full', 'bg-secondary', 'text-base', 'min-h-11')
    // Status is a glyph with sr-only text, never a visible chip beside the title.
    expect(within(row).getByText('Working')).toHaveClass('sr-only')
    expect(screen.queryByText('Index title')).not.toBeInTheDocument()
  })

  it('filters on the title the row shows, the live one for an open chat', () => {
    seedHistory([{ id: 's1', title: 'Index title' }])
    seedOptionsSession('s1', 'agent-1', { title: 'Live title' })
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }])
    renderList({ query: 'live' })

    expect(screen.getByRole('button', { name: 'Live title' })).toBeInTheDocument()
  })

  it('leaves out an open chat tab known to belong to another project, keeping unknown ones', () => {
    seedHistory([{ id: 'h1', title: 'Past chat' }])
    seedOptionsSession('s7', 'agent-1', { title: 'Other project chat', projectId: 'p2' })
    seedOptionsSession('s8', 'agent-1', { title: 'Unattributed chat', projectId: '' })
    seedTabs([
      { type: 'agent-chat', id: 'tab-7', sessionId: 's7' },
      { type: 'agent-chat', id: 'tab-8', sessionId: 's8' }
    ])
    renderList()

    expect(screen.queryByRole('button', { name: 'Other project chat' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Unattributed chat' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Past chat' })).toBeInTheDocument()
  })

  it('lists an open chat the index does not have yet at the top of Today', () => {
    seedHistory([{ id: 'h1', title: 'Past chat' }])
    seedOptionsSession('s9', 'agent-1', { title: 'Brand new chat' })
    seedTabs([{ type: 'agent-chat', id: 'tab-9', sessionId: 's9' }], 'tab-9')
    renderList({ activeTabId: 'tab-9' })

    const today = screen.getByRole('group', { name: 'Today' })
    const buttons = within(today).getAllByRole('button', { name: /^(Brand new|Past) chat$/ })
    expect(buttons[0]).toHaveAccessibleName('Brand new chat')
    expect(buttons[1]).toHaveAccessibleName('Past chat')
  })

  it('selects an open chat through its tab, and opens a history chat through the store', () => {
    seedHistory([
      { id: 's1', title: 'Open one' },
      { id: 'h2', title: 'Past chat', ageMs: 10 }
    ])
    seedOptionsSession('s1', 'agent-1', { title: 'Open one' })
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }])
    renderList()

    fireEvent.click(screen.getByRole('button', { name: 'Open one' }))
    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'tab-1')
    expect(onNavigate).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Past chat' }))
    expect(mockOpenHistorySession).toHaveBeenCalledWith('h2')
    expect(mockAddAgentChatTab).toHaveBeenCalledWith('h2')
    expect(onNavigate).toHaveBeenCalledTimes(2)
  })

  it('truncates a long title and keeps the status glyph and actions on the row', () => {
    const long = 'A very long chat title that keeps going and going past the drawer width ok'
    expect(long.length).toBeGreaterThanOrEqual(70)
    seedHistory([{ id: 's1', title: long }])
    seedOptionsSession('s1', 'agent-1', { title: long, activeTurn: true, openTurnId: 't1' })
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }])
    renderList()

    const title = screen.getByText(long)
    expect(title).toHaveClass('truncate', 'min-w-0', 'flex-1')
    const row = screen.getByRole('button', { name: `${long}, Working` })
    expect(row).toHaveClass('min-w-0', 'w-full')
    // The glyph slot never shrinks; the actions button is pinned inside the row.
    expect(within(row).getByText('Working').closest('.shrink-0')).toBeTruthy()
    const actions = screen.getByRole('button', { name: `More actions for ${long}` })
    expect(actions).toHaveClass('absolute', 'right-1')
  })

  it('shows no trailing action icons until the actions button holds keyboard focus', () => {
    seedHistory([{ id: 'h1', title: 'Past chat' }])
    renderList()

    const actions = screen.getByRole('button', { name: 'More actions for Past chat' })
    // Shown on any focus, so a screen reader's double-tap reaches it too.
    expect(actions).toHaveClass(
      'opacity-0',
      'pointer-events-none',
      'focus:opacity-100',
      'focus:pointer-events-auto'
    )
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument()
  })
})

describe('MobileRecentsList row actions', () => {
  it('long-press on an open chat that is not in history offers Close only', async () => {
    seedHistory([])
    seedOptionsSession('s9', 'agent-1', { title: 'Fresh one' })
    seedTabs([{ type: 'agent-chat', id: 'tab-9', sessionId: 's9' }])
    renderList()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Fresh one' }))
    const sheet = await screen.findByRole('dialog', { name: 'Fresh one' })
    expect(within(sheet).getByRole('button', { name: 'Close chat' })).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: 'Delete chat' })).not.toBeInTheDocument()
  })

  it('leaves the tab in place while the chat close is still pending', async () => {
    mockRequestCloseAgentChat.mockImplementation(() => {
      // A running turn: the close waits, so the tab callback is not invoked.
    })
    seedHistory([{ id: 's1', title: 'Open one' }])
    seedOptionsSession('s1', 'agent-1', { title: 'Open one' })
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }])
    renderList()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open one' }))
    const sheet = await screen.findByRole('dialog', { name: 'Open one' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close chat' }))

    expect(mockRequestCloseAgentChat).toHaveBeenCalledWith('s1', expect.any(Function))
    expect(workspaceRef.current.removeTab).not.toHaveBeenCalled()
  })

  it('on /snapshots, selecting an open chat activates it without navigating (setActiveTab owns /c/<id>)', () => {
    seedHistory([{ id: 's1', title: 'Open one' }])
    seedOptionsSession('s1', 'agent-1', { title: 'Open one' })
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }])
    renderList({}, '/snapshots')

    fireEvent.click(screen.getByRole('button', { name: 'Open one' }))

    expect(workspaceRef.current.setActiveTab).toHaveBeenCalledWith('pane-1', 'tab-1')
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('a right-click or the menu key opens the actions without swallowing the next Enter', async () => {
    seedHistory([{ id: 'h1', title: 'Past chat' }])
    renderList()
    const row = screen.getByRole('button', { name: 'Past chat' })

    fireEvent.contextMenu(row)
    expect(await screen.findByRole('dialog', { name: 'Past chat' })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // No click followed the right-click: the next activation selects the row.
    fireEvent.keyDown(row, { key: 'Enter' })
    fireEvent.click(row)
    expect(mockOpenHistorySession).toHaveBeenCalledWith('h1')
  })

  it('long-press on an open chat in history offers Close and Delete; Close goes through requestCloseAgentChat', async () => {
    seedHistory([{ id: 's1', title: 'Open one' }])
    seedOptionsSession('s1', 'agent-1', { title: 'Open one' })
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }])
    renderList()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open one' }))
    const sheet = await screen.findByRole('dialog', { name: 'Open one' })
    expect(within(sheet).getByRole('button', { name: 'Delete chat' })).toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close chat' }))

    expect(mockRequestCloseAgentChat).toHaveBeenCalledWith('s1', expect.any(Function))
    expect(workspaceRef.current.removeTab).toHaveBeenCalledWith('tab-1')
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('the keyboard actions button on a history chat offers Delete, behind the confirm', async () => {
    seedHistory([{ id: 'h1', title: 'Past chat' }])
    renderList()

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Past chat' }))
    const sheet = await screen.findByRole('dialog', { name: 'Past chat' })
    expect(within(sheet).queryByRole('button', { name: 'Close chat' })).not.toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete chat' }))

    const confirm = await screen.findByRole('alertdialog')
    expect(mockDeleteHistorySession).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }))
    expect(mockDeleteHistorySession).toHaveBeenCalledWith('h1')
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('a touch held still opens the actions and swallows the click that ends it', async () => {
    vi.useFakeTimers()
    try {
      seedHistory([{ id: 'h1', title: 'Past chat' }])
      renderList()
      const row = screen.getByRole('button', { name: 'Past chat' })

      fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 10, clientY: 10 })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      fireEvent.pointerUp(row, { pointerType: 'touch' })
      fireEvent.click(row)

      expect(mockOpenHistorySession).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
    expect(await screen.findByRole('dialog', { name: 'Past chat' })).toBeInTheDocument()
  })

  it('a touch that moves is a scroll: no actions, the tap still opens', () => {
    vi.useFakeTimers()
    try {
      seedHistory([{ id: 'h1', title: 'Past chat' }])
      renderList()
      const row = screen.getByRole('button', { name: 'Past chat' })

      fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 10, clientY: 10 })
      fireEvent.pointerMove(row, { pointerType: 'touch', clientX: 10, clientY: 60 })
      act(() => {
        vi.advanceTimersByTime(600)
      })
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

      fireEvent.pointerUp(row, { pointerType: 'touch' })
      fireEvent.click(row)
      expect(mockOpenHistorySession).toHaveBeenCalledWith('h1')
    } finally {
      vi.useRealTimers()
    }
  })
})
