import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockSessionIndexEntry } from '@/lib/test-utils/acp'
import { resetChatActivity, seedChatActivity } from '@/lib/test-utils/chat-activity'
import { useAcpStore } from '@/stores/acp-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import { RailProjectChats } from './RailProjectChats'
import { RAIL_CHAT_STATUS_DOT_CLASS } from './rail-chat-status'
import { RailDensityProvider } from './rail-density'

const mocks = vi.hoisted(() => ({
  addAgentChatTab: vi.fn(),
  openHistorySession: vi.fn(),
  logFrontendError: vi.fn()
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: mocks.logFrontendError }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const project = {
  id: 'p1',
  name: 'Alpha',
  path: '/repo',
  color: 'blue',
  gitBranch: 'main',
  isGitRepo: true
} as Project

const entry = (id: string, lastActivityAt: number) =>
  mockSessionIndexEntry({
    id,
    title: `Chat ${id}`,
    cwd: '/repo',
    projectId: 'p1',
    status: 'active',
    lastActivityAt
  })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.openHistorySession.mockResolvedValue(undefined)
  resetShellLayoutStoreForTests()
  useShellLayoutStore.setState({ status: 'ready' })
  resetChatActivity()
  useAcpStore.setState({
    sessionIndex: [],
    sessions: {},
    agentConfigs: [],
    openHistorySession: mocks.openHistorySession
  })
  useWorkspaceStore.setState({
    activePaneId: 'pane-1',
    addAgentChatTab: mocks.addAgentChatTab,
    root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null }
  } as never)
})

const list = () => screen.getByRole('list', { name: 'Chats in Alpha' })
const rows = () => within(list()).getAllByRole('button')

describe('RailProjectChats', () => {
  it('renders nothing without chats', () => {
    const { container } = render(<RailProjectChats project={project} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('lists the newest five chats, then Show N more', () => {
    useAcpStore.setState({
      sessionIndex: Array.from({ length: 7 }, (_, i) => entry(`c${i}`, i)).concat(
        mockSessionIndexEntry({ id: 'other', projectId: 'p2', title: 'Other' })
      )
    })
    render(<RailProjectChats project={project} />)
    expect(rows().map((row) => row.getAttribute('title'))).toEqual([
      'Chat c6',
      'Chat c5',
      'Chat c4',
      'Chat c3',
      'Chat c2'
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }))
    expect(rows()).toHaveLength(7)
  })

  it('names each row with its status and shows the trail', () => {
    useAcpStore.setState({ sessionIndex: [entry('a', 2), entry('b', 1)] })
    seedChatActivity({ a: { needsYou: true } })
    render(<RailProjectChats project={project} />)
    const needsYou = screen.getByRole('button', { name: 'Chat a, Needs you' })
    expect(needsYou).toHaveTextContent('Needs you')
    expect(screen.getByRole('button', { name: 'Chat b' })).toBeInTheDocument()
  })

  it('marks the open chat with the keycap and aria-current', () => {
    useAcpStore.setState({ sessionIndex: [entry('a', 2), entry('b', 1)] })
    useWorkspaceStore.setState({
      root: {
        type: 'leaf',
        id: 'pane-1',
        tabs: [{ id: 'tab-b', type: 'agent-chat', sessionId: 'b' }],
        activeTabId: 'tab-b'
      }
    } as never)
    render(<RailProjectChats project={project} />)
    const open = screen.getByRole('button', { name: 'Chat b' })
    expect(open).toHaveAttribute('aria-current', 'true')
    expect(open).toHaveClass('keycap')
    expect(screen.getByRole('button', { name: 'Chat a' })).not.toHaveAttribute('aria-current')
  })

  it('opens the chat on click and writes one info log from the Rail', () => {
    useAcpStore.setState({ sessionIndex: [entry('a', 1)] })
    render(<RailProjectChats project={project} />)
    fireEvent.click(screen.getByRole('button', { name: 'Chat a' }))
    expect(mocks.openHistorySession).toHaveBeenCalledWith('a')
    expect(mocks.addAgentChatTab).toHaveBeenCalledWith('a')
    expect(mocks.logFrontendError).toHaveBeenCalledTimes(1)
    expect(mocks.logFrontendError).toHaveBeenCalledWith({
      level: 'info',
      source: 'Rail',
      message: '[rail] open chat a'
    })
  })
})

describe('RailProjectChats on the collapsed Rail', () => {
  const renderCollapsed = () =>
    render(
      <RailDensityProvider density="collapsed">
        <RailProjectChats project={project} />
      </RailDensityProvider>
    )
  const peek = () => screen.findByTestId('rail-chat-peek')

  it('draws one agent icon per chat at the same 30px row, no title and no trail', () => {
    useAcpStore.setState({ sessionIndex: [entry('a', 2), entry('b', 1)] })
    seedChatActivity({ a: { needsYou: true } })
    renderCollapsed()
    const row = screen.getByRole('button', { name: 'Chat a, Needs you' })
    expect(row).toHaveClass('h-7.5', 'justify-center')
    expect(row).not.toHaveClass('pl-8.75')
    expect(row).toHaveTextContent('')
    expect(row).not.toHaveAttribute('title')
  })

  it('maps each live state to a status dot on the icon', () => {
    useAcpStore.setState({
      sessionIndex: [entry('n', 4), entry('r', 3), entry('d', 2), entry('i', 1)]
    })
    seedChatActivity({ n: { needsYou: true }, r: { busy: true }, d: { unread: true } })
    renderCollapsed()
    const dot = (name: string) =>
      screen.getByRole('button', { name }).querySelector('[data-rail-chat-status]')
    expect(dot('Chat n, Needs you')).toHaveClass('bg-warning', 'size-1.5', 'rounded-full')
    expect(dot('Chat r, Running')).toHaveClass('bg-primary')
    expect(dot('Chat d, New activity')).toHaveClass('bg-foreground')
    expect(dot('Chat i')).toBeNull()
  })

  it('maps the live states in one table, idle without a dot', () => {
    expect(RAIL_CHAT_STATUS_DOT_CLASS).toEqual({
      'needs-you': 'bg-warning',
      running: 'bg-primary',
      done: 'bg-foreground',
      idle: null
    })
  })

  it('reads "···" for Show N more, with the words in its name', () => {
    useAcpStore.setState({ sessionIndex: Array.from({ length: 7 }, (_, i) => entry(`c${i}`, i)) })
    renderCollapsed()
    const more = screen.getByRole('button', { name: 'Show 2 more chats' })
    expect(more).toHaveTextContent('···')
    expect(more).toHaveClass('h-7', 'justify-center')
    fireEvent.click(more)
    expect(rows().filter((row) => row.getAttribute('aria-label')?.startsWith('Chat'))).toHaveLength(
      7
    )
  })

  it('opens the chat peek on hover: the project row and the chat rows, hovered row filled', async () => {
    useAcpStore.setState({ sessionIndex: [entry('a', 2), entry('b', 1)] })
    renderCollapsed()
    const railRow = screen.getByRole('button', { name: 'Chat b' })
    fireEvent.pointerEnter(railRow)
    const panel = await peek()
    expect(panel).toHaveClass('w-60', 'rounded-[10px]', 'p-1', 'gap-px', 'outline-popover-edge')
    expect(panel).toHaveTextContent('Alpha')
    const peekRows = within(panel).getAllByRole('button')
    expect(peekRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Chat a'),
      expect.stringContaining('Chat b')
    ])
    expect(within(panel).getByRole('button', { name: 'Chat b' })).toHaveAttribute(
      'data-highlighted'
    )
    expect(within(panel).getByRole('button', { name: 'Chat a' })).not.toHaveAttribute(
      'data-highlighted'
    )
  })

  it('opens on keyboard focus and closes on Escape', async () => {
    useAcpStore.setState({ sessionIndex: [entry('a', 1)] })
    renderCollapsed()
    fireEvent.focus(screen.getByRole('button', { name: 'Chat a' }))
    await peek()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('rail-chat-peek')).toBeNull())
  })

  it('opens the chat from the peek, logs it and closes', async () => {
    useAcpStore.setState({ sessionIndex: [entry('a', 2), entry('b', 1)] })
    renderCollapsed()
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Chat a' }))
    const panel = await peek()
    fireEvent.click(within(panel).getByRole('button', { name: 'Chat b' }))
    expect(mocks.openHistorySession).toHaveBeenCalledWith('b')
    expect(mocks.logFrontendError).toHaveBeenCalledWith({
      level: 'info',
      source: 'Rail',
      message: '[rail] peek open chat b'
    })
    await waitFor(() => expect(screen.queryByTestId('rail-chat-peek')).toBeNull())
  })
})
