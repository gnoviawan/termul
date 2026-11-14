import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockSessionIndexEntry } from '@/lib/test-utils/acp'
import { resetChatActivity, seedChatActivity } from '@/lib/test-utils/chat-activity'
import { useAcpStore } from '@/stores/acp-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import { RailProjectChats } from './RailProjectChats'

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
