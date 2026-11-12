import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatChatCreatedTime } from '@/lib/relative-time'
import { mockSessionIndexEntry } from '@/lib/test-utils/acp'
import { resetChatActivity, seedChatActivity } from '@/lib/test-utils/chat-activity'
import { _resetEphemeralSessionIdsForTesting, useAcpStore } from '@/stores/acp-store'
import { FRESH, seedOptionsSession } from '@/stores/acp-store/testkit'
import { useProjectStore } from '@/stores/project-store'
import { MobileRecentsList } from './MobileRecentsList'

const {
  workspaceRef,
  mockCloseAgentChat,
  mockAddAgentChatTab,
  mockNavigate,
  mockWriteText,
  mockToastSuccess
} = vi.hoisted(() => ({
  mockWriteText: vi.fn(),
  mockToastSuccess: vi.fn(),
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
  mockCloseAgentChat: vi.fn(),
  mockAddAgentChatTab: vi.fn()
}))

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

vi.mock('@/lib/clipboard-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/clipboard-api')>()),
  clipboardApi: { writeText: mockWriteText }
}))

vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: vi.fn() } }))

vi.mock('@/lib/agent-chat-close', () => ({
  closeAgentChat: mockCloseAgentChat
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

/**
 * `ageMs` ages the last activity; `createdAt` is absolute and defaults to 0
 * (unknown: the row shows no time and sorts under Earlier).
 */
function seedHistory(
  entries: Array<{ id: string; title: string; ageMs?: number; createdAt?: number }>
): void {
  useAcpStore.setState({
    sessionIndex: entries.map(({ id, title, ageMs = 0, createdAt = 0 }) =>
      mockSessionIndexEntry({
        id,
        title,
        projectId: 'p1',
        cwd: '/work',
        status: 'active',
        createdAt,
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
/** A fixed local midday, so `now - DAY` is always yesterday and minutes ago always today. */
const NOON = new Date(2026, 9, 30, 12, 0).getTime()

/** Pin `Date.now()` to `NOON`; timers stay real so `waitFor` still polls. */
function pinClock(): number {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOON)
  return NOON
}

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  onNavigate.mockReset()
  mockNavigate.mockReset()
  mockAddAgentChatTab.mockReset()
  mockWriteText.mockReset().mockResolvedValue({ success: true })
  mockToastSuccess.mockReset()
  mockOpenHistorySession.mockReset().mockResolvedValue(undefined)
  mockDeleteHistorySession.mockReset().mockResolvedValue(undefined)
  mockCloseAgentChat
    .mockReset()
    .mockImplementation((_id: string, closeTab: () => void) => closeTab())
  workspaceRef.current.removeTab.mockReset()
  workspaceRef.current.setActiveTab.mockReset()
  workspaceRef.current.fullscreenPaneId = null
  useAcpStore.setState(FRESH)
  _resetEphemeralSessionIdsForTesting()
  resetChatActivity()
  useProjectStore.setState({
    projects: [
      {
        id: 'p1',
        name: 'termul',
        color: 'blue',
        path: '/work',
        gitBranch: 'main',
        isGitRepo: true,
        worktrees: []
      }
    ],
    activeProjectId: 'p1'
  })
  seedTabs([])
})

describe('MobileRecentsList merged list', () => {
  it('groups chats into Today, Yesterday and Earlier by when they were created', () => {
    const now = pinClock()
    seedHistory([
      { id: 'a', title: 'Today chat', createdAt: now },
      { id: 'b', title: 'Yesterday chat', createdAt: now - DAY },
      // Created long ago, active just now: still Earlier.
      { id: 'c', title: 'Old chat', createdAt: now - 10 * DAY }
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
    seedOptionsSession('s1', 'agent-1', { title: 'Live title' })
    seedChatActivity({ s1: { busy: true } })
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

  it('shows the host status of an open chat this phone has not loaded yet', () => {
    seedHistory([{ id: 's1', title: 'Desktop chat' }])
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }], null)
    seedChatActivity({ s1: { busy: true, needsYou: true } })
    renderList()

    const row = screen.getByRole('button', { name: /^Desktop chat, Needs you, Working/ })
    expect(within(row).getByTitle('Working')).toBeInTheDocument()
  })

  it('shows the host status of a Recents chat with no tab here, Failed included', () => {
    seedHistory([
      { id: 'busy', title: 'Busy chat' },
      { id: 'done', title: 'Done chat', ageMs: 10 },
      { id: 'idle', title: 'Idle chat', ageMs: 20 }
    ])
    useAcpStore.setState({
      sessionIndex: [
        ...(useAcpStore.getState().sessionIndex ?? []),
        mockSessionIndexEntry({
          id: 'fail',
          title: 'Failed chat',
          projectId: 'p1',
          cwd: '/work',
          status: 'error',
          lastActivityAt: Date.now() - 30
        })
      ]
    })
    seedChatActivity({
      busy: { busy: true },
      done: { unread: true, turnEnd: { seq: 4, logEpoch: 'e1' } },
      fail: { needsYou: true }
    })
    renderList()

    expect(screen.getByRole('button', { name: /^Busy chat, Working/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Done chat, New activity/ })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^Failed chat, Failed, Needs you/ })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Idle chat(, created .*)?$/ })).toBeInTheDocument()
  })

  it('filters on the title the row shows, the live one for an open chat', () => {
    seedHistory([{ id: 's1', title: 'Index title' }])
    seedOptionsSession('s1', 'agent-1', { title: 'Live title' })
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }])
    renderList({ query: 'live' })

    expect(screen.getByRole('button', { name: 'Live title' })).toBeInTheDocument()
  })

  it('lists every open chat tab of the tree, whatever project its session names', () => {
    seedHistory([{ id: 'h1', title: 'Past chat' }])
    seedOptionsSession('s7', 'agent-1', { title: 'Other project chat', projectId: 'p2' })
    seedOptionsSession('s8', 'agent-1', { title: 'Unattributed chat', projectId: '' })
    seedTabs([
      { type: 'agent-chat', id: 'tab-7', sessionId: 's7' },
      { type: 'agent-chat', id: 'tab-8', sessionId: 's8' }
    ])
    renderList()

    expect(
      screen.getByRole('button', { name: /^Other project chat, created / })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Unattributed chat, created / })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Past chat' })).toBeInTheDocument()
  })

  it('lists an open chat the index does not have yet under Active, timed by its live session', () => {
    const now = pinClock()
    const createdAt = now - 60_000
    seedHistory([{ id: 'h1', title: 'Past chat', createdAt: now }])
    seedOptionsSession('s9', 'agent-1', { title: 'Brand new chat', createdAt })
    seedTabs([{ type: 'agent-chat', id: 'tab-9', sessionId: 's9' }], 'tab-9')
    renderList({ activeTabId: 'tab-9' })

    const time = formatChatCreatedTime(createdAt, now)
    const active = screen.getByRole('group', { name: 'Active' })
    expect(
      within(active).getByRole('button', { name: `Brand new chat, created ${time}` })
    ).toHaveAttribute('aria-current', 'page')
    expect(within(active).getByText(time)).toHaveClass('text-muted-foreground')
    expect(
      within(screen.getByRole('group', { name: 'Today' })).getByText('Past chat')
    ).toBeInTheDocument()
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
    seedOptionsSession('s1', 'agent-1', { title: long })
    seedChatActivity({ s1: { busy: true } })
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
    seedOptionsSession('s9', 'agent-1', { title: 'Fresh one', createdAt: 0 })
    seedTabs([{ type: 'agent-chat', id: 'tab-9', sessionId: 's9' }])
    renderList()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Fresh one' }))
    const sheet = await screen.findByRole('dialog', { name: 'Fresh one' })
    expect(within(sheet).getByRole('button', { name: 'Close chat' })).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: 'Delete chat' })).not.toBeInTheDocument()
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

  it('long-press on an open chat in history offers Close and Delete; Close goes through closeAgentChat', async () => {
    seedHistory([{ id: 's1', title: 'Open one' }])
    seedOptionsSession('s1', 'agent-1', { title: 'Open one' })
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }])
    renderList()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Open one' }))
    const sheet = await screen.findByRole('dialog', { name: 'Open one' })
    expect(within(sheet).getByRole('button', { name: 'Delete chat' })).toBeInTheDocument()
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close chat' }))

    expect(mockCloseAgentChat).toHaveBeenCalledWith('s1', expect.any(Function))
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

  it('copies the reference of a history chat', async () => {
    seedHistory([{ id: 'h1', title: 'Past chat' }])
    renderList()

    fireEvent.contextMenu(screen.getByRole('button', { name: 'Past chat' }))
    const sheet = await screen.findByRole('dialog', { name: 'Past chat' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy chat reference' }))

    await waitFor(() =>
      expect(mockWriteText).toHaveBeenCalledWith(
        'Troupe chat: Past chat\nChat ID: h1\nProject: termul (ID p1)\nFolder: /work\nRead it with the Troupe read_chat tool.'
      )
    )
    expect(mockToastSuccess).toHaveBeenCalledWith('Chat reference copied', { description: 'h1' })
  })

  it('copies the reference of an open chat under its own project and live title', async () => {
    useProjectStore.setState({
      projects: [
        ...useProjectStore.getState().projects,
        { id: 'p2', name: 'skills-lab', color: 'blue', path: '/lab', worktrees: [] }
      ]
    })
    seedHistory([])
    seedOptionsSession('s7', 'agent-1', {
      title: 'Other project chat',
      projectId: 'p2',
      cwd: '/lab'
    })
    seedTabs([{ type: 'agent-chat', id: 'tab-7', sessionId: 's7' }])
    renderList()

    fireEvent.contextMenu(screen.getByRole('button', { name: /^Other project chat/ }))
    const sheet = await screen.findByRole('dialog', { name: 'Other project chat' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Copy chat reference' }))

    await waitFor(() =>
      expect(mockWriteText).toHaveBeenCalledWith(
        'Troupe chat: Other project chat\nChat ID: s7\nProject: skills-lab (ID p2)\nFolder: /lab\nRead it with the Troupe read_chat tool.'
      )
    )
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

describe('MobileRecentsList Active section and created time', () => {
  let now = NOON
  beforeEach(() => {
    now = pinClock()
  })

  const groupNames = (): string[] =>
    screen
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-labelledby') ?? '')
      .map((id) => document.getElementById(id)?.textContent ?? '')

  it('lists two open chats under Active, above the date sections, newest-created first', () => {
    seedHistory([
      { id: 'o1', title: 'Open older', createdAt: now - 2 * DAY },
      { id: 'o2', title: 'Open newer', createdAt: now - 60_000 },
      { id: 'c1', title: 'Closed today', createdAt: now - 120_000 },
      { id: 'c2', title: 'Closed yesterday', createdAt: now - DAY },
      { id: 'c3', title: 'Closed old', createdAt: now - 10 * DAY }
    ])
    seedTabs([
      { type: 'agent-chat', id: 'tab-o1', sessionId: 'o1' },
      { type: 'agent-chat', id: 'tab-o2', sessionId: 'o2' }
    ])
    renderList()

    expect(groupNames()).toEqual(['Active', 'Today', 'Yesterday', 'Earlier'])
    const active = within(screen.getByRole('group', { name: 'Active' })).getAllByRole('button', {
      name: /^Open/
    })
    expect(active.map((row) => row.getAttribute('aria-label'))).toEqual([
      `Open newer, created ${formatChatCreatedTime(now - 60_000, now)}`,
      `Open older, created ${formatChatCreatedTime(now - 2 * DAY, now)}`
    ])
  })

  it('moves a closed chat to its date section with the same created time', () => {
    const createdAt = now - DAY
    const time = formatChatCreatedTime(createdAt, now)
    // Active has no date heading, so the row names the day itself.
    expect(time).toMatch(/^Yesterday /)
    seedHistory([{ id: 's1', title: 'Chat one', createdAt }])
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }])
    const view = renderList()
    expect(
      within(screen.getByRole('group', { name: 'Active' })).getByRole('button', {
        name: `Chat one, created ${time}`
      })
    ).toBeInTheDocument()

    seedTabs([])
    view.rerender(
      <MemoryRouter>
        <h2 id="recents-heading">Recents</h2>
        <MobileRecentsList
          query=""
          headingId="recents-heading"
          activeTabId={null}
          onNavigate={onNavigate}
        />
      </MemoryRouter>
    )

    expect(screen.queryByRole('group', { name: 'Active' })).not.toBeInTheDocument()
    expect(
      within(screen.getByRole('group', { name: 'Yesterday' })).getByRole('button', {
        name: `Chat one, created ${time}`
      })
    ).toBeInTheDocument()
  })

  it('shows a reopened old chat under Active with its original created time, not now', () => {
    const createdAt = now - 3 * DAY
    seedHistory([{ id: 's1', title: 'Old chat', createdAt }])
    // Reopening stamps the live session with now; the index keeps the original.
    seedOptionsSession('s1', 'agent-1', { title: 'Old chat', createdAt: now })
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }])
    renderList()

    const time = formatChatCreatedTime(createdAt, now)
    expect(time).not.toBe(formatChatCreatedTime(now, now))
    expect(
      within(screen.getByRole('group', { name: 'Active' })).getByRole('button', {
        name: `Old chat, created ${time}`
      })
    ).toBeInTheDocument()
  })

  it('times an open chat indexed under another project by its index entry, not the newer live stamp', () => {
    const createdAt = now - 3 * DAY
    useAcpStore.setState({
      sessionIndex: [
        mockSessionIndexEntry({
          id: 's7',
          title: 'Other project chat',
          projectId: 'p2',
          cwd: '/elsewhere',
          status: 'active',
          createdAt,
          lastActivityAt: now
        })
      ]
    })
    // Reopening stamped the live session with now.
    seedOptionsSession('s7', 'agent-1', {
      title: 'Other project chat',
      projectId: 'p2',
      createdAt: now
    })
    seedTabs([{ type: 'agent-chat', id: 'tab-7', sessionId: 's7' }])
    renderList()

    const time = formatChatCreatedTime(createdAt, now)
    expect(time).not.toBe(formatChatCreatedTime(now, now))
    expect(
      within(screen.getByRole('group', { name: 'Active' })).getByRole('button', {
        name: `Other project chat, created ${time}`
      })
    ).toBeInTheDocument()
  })

  it('shows no time for an open chat with no created time', () => {
    seedHistory([])
    seedOptionsSession('s9', 'agent-1', { title: 'Untimed chat', createdAt: 0 })
    seedTabs([{ type: 'agent-chat', id: 'tab-9', sessionId: 's9' }])
    renderList()

    const row = within(screen.getByRole('group', { name: 'Active' })).getByRole('button', {
      name: 'Untimed chat'
    })
    expect(row.querySelector('.tabular-nums')).toBeNull()
  })

  it('hides the Active section when the search matches only closed chats', () => {
    seedHistory([
      { id: 's1', title: 'Open chat', createdAt: now },
      { id: 'h1', title: 'Closed match', createdAt: now }
    ])
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 's1' }])
    renderList({ query: 'match' })

    expect(groupNames()).toEqual(['Today'])
    expect(screen.queryByRole('group', { name: 'Active' })).not.toBeInTheDocument()
  })

  it('keeps an open chat under Active even when it is older than the lazy window', () => {
    seedHistory([
      { id: 'open-oldest', title: 'Oldest open', createdAt: now - 100 * DAY },
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `h${i}`,
        title: `Closed ${i}`,
        createdAt: now - i * 60_000
      }))
    ])
    seedTabs([{ type: 'agent-chat', id: 'tab-1', sessionId: 'open-oldest' }])
    renderList()

    expect(
      within(screen.getByRole('group', { name: 'Active' })).getByText('Oldest open')
    ).toBeInTheDocument()
    // The window pages only the closed chats: 50 rendered, 10 left.
    expect(screen.getByRole('button', { name: 'Load more (10 more)' })).toBeInTheDocument()
  })
})
