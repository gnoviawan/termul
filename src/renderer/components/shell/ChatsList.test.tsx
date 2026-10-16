import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockAcpSession, mockSessionIndexEntry } from '@/lib/test-utils/acp'
import {
  _addEphemeralSessionIdForTesting,
  _resetEphemeralSessionIdsForTesting,
  useAcpStore
} from '@/stores/acp-store'
import { useAgentChatUnreadStore } from '@/stores/agent-chat-unread-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import { ChatsList } from './ChatsList'

const mocks = vi.hoisted(() => ({
  openTerminalAtCwd: vi.fn(),
  addAgentChatTab: vi.fn(),
  openHistorySession: vi.fn(),
  deleteHistorySession: vi.fn(),
  writeText: vi.fn(),
  revealInFileManager: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  logFrontendError: vi.fn(),
  startChatDrag: vi.fn(),
  openAgentChatPlaced: vi.fn()
}))

vi.mock('@/lib/terminal-spawn', () => ({ openTerminalAtCwd: mocks.openTerminalAtCwd }))
vi.mock('@/lib/api', () => ({
  clipboardApi: { writeText: mocks.writeText },
  openerApi: { revealInFileManager: mocks.revealInFileManager }
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mocks.logFrontendError }))
vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: () => ({ startChatDrag: mocks.startChatDrag })
}))
vi.mock('@/lib/open-agent-chat', () => ({ openAgentChatPlaced: mocks.openAgentChatPlaced }))
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }))

const project = {
  id: 'p1',
  name: 'Repo',
  path: '/repo',
  color: 'blue',
  gitBranch: 'main',
  isGitRepo: true,
  worktrees: [
    {
      id: 'w1',
      name: 'feature',
      branch: 'feat/x',
      path: '/repo/.termul/worktrees/feature',
      createdAt: '2026-01-01T00:00:00.000Z'
    }
  ]
} as Project

const entry = (id: string, overrides = {}) =>
  mockSessionIndexEntry({
    id,
    title: `Chat ${id}`,
    cwd: '/repo',
    projectId: 'p1',
    status: 'active',
    lastActivityAt: 1000,
    ...overrides
  })

const setIndex = (sessionIndex: ReturnType<typeof entry>[]) =>
  useAcpStore.setState({ sessionIndex })

let offsetHeight: PropertyDescriptor | undefined

beforeEach(() => {
  mocks.openTerminalAtCwd.mockReset().mockResolvedValue({ status: 'opened', terminalId: 't1' })
  mocks.addAgentChatTab.mockReset()
  mocks.toastSuccess.mockReset()
  mocks.toastError.mockReset()
  mocks.logFrontendError.mockReset()
  mocks.startChatDrag.mockReset()
  mocks.openAgentChatPlaced.mockReset()
  mocks.openHistorySession.mockReset().mockResolvedValue(undefined)
  mocks.deleteHistorySession.mockReset().mockResolvedValue(undefined)
  mocks.writeText.mockReset().mockResolvedValue({ success: true })
  mocks.revealInFileManager.mockReset().mockResolvedValue({ success: true })
  resetShellLayoutStoreForTests()
  useShellLayoutStore.setState({ status: 'ready' })
  useAgentChatUnreadStore.setState({ unread: {} })
  _resetEphemeralSessionIdsForTesting()
  useAcpStore.setState({
    sessionIndex: [],
    sessions: {},
    agentConfigs: [],
    openHistorySession: mocks.openHistorySession,
    deleteHistorySession: mocks.deleteHistorySession
  })
  useWorkspaceStore.setState({ activePaneId: 'pane-1', addAgentChatTab: mocks.addAgentChatTab })
  offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  // jsdom has no layout: give the scroll viewport (and the measured cards) a size.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return this.dataset?.testid === 'chats-list-scroll' ? 400 : 60
    }
  })
})

afterEach(() => {
  if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
  else Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight')
})

const cardButtons = () => screen.getAllByRole('button', { name: /^Chat / })
const titles = () => cardButtons().map((b) => b.getAttribute('title'))

describe('ChatsList scope and order', () => {
  it('lists the project chats newest first', () => {
    setIndex([
      entry('a', { lastActivityAt: 10 }),
      entry('b', { lastActivityAt: 30 }),
      entry('c', { lastActivityAt: 20 }),
      entry('x', { projectId: 'p2', lastActivityAt: 99 })
    ])
    render(<ChatsList project={project} />)
    expect(titles()).toEqual(['Chat b', 'Chat c', 'Chat a'])
  })

  it('narrows to the picked worktree and ignores a pruned pick', () => {
    setIndex([entry('root'), entry('wt', { cwd: '/repo/.termul/worktrees/feature' })])
    useShellLayoutStore.setState({
      worktreePickByProject: { p1: '/repo/.termul/worktrees/feature' }
    })
    const { unmount } = render(<ChatsList project={project} />)
    expect(titles()).toEqual(['Chat wt'])
    unmount()

    useShellLayoutStore.setState({ worktreePickByProject: { p1: '/repo/.termul/worktrees/gone' } })
    render(<ChatsList project={project} />)
    expect(cardButtons()).toHaveLength(2)
  })

  it('shows the empty line when the project has no chats', () => {
    render(<ChatsList project={project} />)
    expect(
      screen.getByText('No chats yet. Start one with the New chat button.')
    ).toBeInTheDocument()
  })

  it('mounts far fewer than 500 cards for a 500-chat project', () => {
    setIndex(Array.from({ length: 500 }, (_, i) => entry(`c${i}`, { lastActivityAt: i })))
    render(<ChatsList project={project} />)
    const mounted = screen.getAllByRole('button', { name: /^Chat c/ }).length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(40)
  })
})

describe('ChatsList search', () => {
  beforeEach(() => {
    useAcpStore.setState({
      agentConfigs: [{ id: 'cfg-1', name: 'Claude Code', command: 'x', args: [], env: {} }]
    })
    setIndex([
      entry('a', { title: 'Refactor Auth', agentConfigId: 'cfg-1' }),
      entry('b', { title: 'Add tests', cwd: '/repo/.termul/worktrees/feature' })
    ])
  })

  it('matches title, agent name and branch, and reports no matches', () => {
    render(<ChatsList project={project} />)
    const field = screen.getByLabelText('Search chats')

    fireEvent.change(field, { target: { value: 'AUTH' } })
    expect(screen.getAllByRole('button', { name: /^Refactor Auth/ })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /^Add tests/ })).toBeNull()

    fireEvent.change(field, { target: { value: 'claude' } })
    expect(screen.getAllByRole('button', { name: /^Refactor Auth/ })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /^Add tests/ })).toBeNull()

    fireEvent.change(field, { target: { value: 'feat/x' } })
    expect(screen.getAllByRole('button', { name: /^Add tests/ })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /^Refactor Auth/ })).toBeNull()

    fireEvent.change(field, { target: { value: 'zzz' } })
    expect(screen.getByText('No matches.')).toBeInTheDocument()
  })

  it('clears the query on Escape', () => {
    render(<ChatsList project={project} />)
    const field = screen.getByLabelText('Search chats') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'zzz' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(field.value).toBe('')
    expect(screen.queryByText('No matches.')).toBeNull()
  })
})

describe('ChatsList card content', () => {
  it('shows the model line and the branch line', () => {
    useAcpStore.setState({
      agentConfigs: [{ id: 'cfg-1', name: 'Claude Code', command: 'x', args: [], env: {} }]
    })
    setIndex([
      entry('live', { agentConfigId: 'cfg-1', modelName: 'Index model', lastActivityAt: 40 }),
      entry('indexed', { agentConfigId: 'cfg-1', modelName: 'Opus', lastActivityAt: 30 }),
      entry('bare', { agentConfigId: 'cfg-1', lastActivityAt: 20 }),
      entry('wt', {
        cwd: '/repo/.termul/worktrees/feature',
        agentConfigId: 'cfg-1',
        lastActivityAt: 10
      })
    ])
    useAcpStore.setState({
      sessions: {
        live: mockAcpSession({
          id: 'live',
          models: {
            currentModelId: 'm2',
            availableModels: [
              { modelId: 'm1', name: 'One' },
              { modelId: 'm2', name: 'Live model' }
            ]
          }
        })
      }
    })
    render(<ChatsList project={project} />)

    const card = (title: string) => screen.getByTitle(title)
    expect(within(card('Chat live')).getByText('Live model')).toBeInTheDocument()
    expect(within(card('Chat indexed')).getByText('Opus')).toBeInTheDocument()
    expect(within(card('Chat bare')).getByText('Claude Code')).toBeInTheDocument()
    expect(within(card('Chat wt')).getByText('feat/x')).toBeInTheDocument()
    expect(within(card('Chat bare')).getByText('main')).toBeInTheDocument()
  })

  it('shows the selected model config option instead of the creation-time model', () => {
    setIndex([entry('live', { modelName: 'Index model' })])
    useAcpStore.setState({
      sessions: {
        live: mockAcpSession({
          id: 'live',
          models: {
            currentModelId: 'haiku',
            availableModels: [
              { modelId: 'haiku', name: 'Haiku 5.5' },
              { modelId: 'sonnet', name: 'Sonnet 5.5' }
            ]
          },
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'sonnet',
              options: [
                { value: 'haiku', name: 'Haiku 5.5' },
                { value: 'sonnet', name: 'Sonnet 5.5' }
              ]
            }
          ]
        })
      }
    })
    render(<ChatsList project={project} />)
    const card = screen.getByTitle('Chat live')
    expect(within(card).getByText('Sonnet 5.5')).toBeInTheDocument()
    expect(within(card).queryByText('Haiku 5.5')).toBeNull()
    expect(within(card).queryByText('Index model')).toBeNull()
  })

  it('leaves the branch line empty on a project without git', () => {
    setIndex([entry('a')])
    render(<ChatsList project={{ ...project, isGitRepo: false }} />)
    expect(within(screen.getByTitle('Chat a')).queryByText('main')).toBeNull()
  })

  it('shows one status per chat and folds it into the accessible name', () => {
    setIndex([
      entry('need', { lastActivityAt: 50 }),
      entry('busy', { lastActivityAt: 40 }),
      entry('done', { lastActivityAt: 30 }),
      entry('fail', { lastActivityAt: 20, status: 'error' }),
      entry('idle', { lastActivityAt: 10 })
    ])
    useAcpStore.setState({
      sessions: {
        need: mockAcpSession({ id: 'need' }),
        busy: mockAcpSession({ id: 'busy', activeTurn: true }),
        done: mockAcpSession({ id: 'done' })
      },
      pendingPermissions: {
        perm: { sessionId: 'need' }
      } as never
    })
    useAgentChatUnreadStore.setState({ unread: { done: true } })
    render(<ChatsList project={project} />)

    expect(screen.getByRole('button', { name: 'Chat need, Needs you' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Chat busy, Running' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Chat done, New activity' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Chat fail' })).toBeInTheDocument()
    expect(within(screen.getByTitle('Chat fail')).getByText('Failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Chat idle' })).toBeInTheDocument()
  })

  it('marks the chat open in the active pane', () => {
    setIndex([entry('a'), entry('b', { lastActivityAt: 5 })])
    useWorkspaceStore.setState({
      root: {
        type: 'leaf',
        id: 'pane-1',
        tabs: [{ id: 'tab-a', type: 'agent-chat', sessionId: 'a' }],
        activeTabId: 'tab-a'
      }
    } as never)
    render(<ChatsList project={project} />)
    expect(screen.getByTitle('Chat a')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTitle('Chat b')).not.toHaveAttribute('aria-current')
    // Selected uses the keycap, the same surface as the Rail's active project.
    expect(screen.getByTitle('Chat a').parentElement).toHaveClass('keycap')
    expect(screen.getByTitle('Chat b').parentElement).not.toHaveClass('keycap')
  })

  it('puts the title on line 1 and the model on line 2', () => {
    setIndex([entry('a', { modelName: 'Opus' })])
    render(<ChatsList project={project} />)
    const [line1, line2] = Array.from(screen.getByTitle('Chat a').children)
    expect(line1).toHaveTextContent('Chat a')
    expect(line2).toHaveTextContent('Opus')
  })

  it('shows New activity on an unread closed chat', () => {
    setIndex([entry('a', { status: 'closed' })])
    useAcpStore.setState({ sessions: { a: mockAcpSession({ id: 'a', status: 'closed' }) } })
    useAgentChatUnreadStore.setState({ unread: { a: true } })
    render(<ChatsList project={project} />)
    expect(screen.getByRole('button', { name: 'Chat a, New activity' })).toBeInTheDocument()
    expect(within(screen.getByTitle('Chat a')).getByTitle('New activity')).toBeInTheDocument()
  })

  it('shows no New activity for an unread ephemeral session', () => {
    setIndex([entry('eph')])
    useAcpStore.setState({ sessions: { eph: mockAcpSession({ id: 'eph' }) } })
    _addEphemeralSessionIdForTesting('eph')
    useAgentChatUnreadStore.setState({ unread: { eph: true } })
    render(<ChatsList project={project} />)
    expect(screen.getByRole('button', { name: 'Chat eph' })).toBeInTheDocument()
    expect(within(screen.getByTitle('Chat eph')).queryByTitle('New activity')).toBeNull()
  })

  it('keeps a closed chat at full opacity and says Closed', () => {
    setIndex([entry('a', { status: 'closed' })])
    render(<ChatsList project={project} />)
    const card = screen.getByTitle('Chat a')
    expect(card.parentElement).not.toHaveClass('opacity-60')
    expect(within(card).getByText(/^Closed · /)).toBeInTheDocument()
  })
})

describe('ChatsList interactions', () => {
  beforeEach(() => setIndex([entry('a', { cwd: '/repo/src' })]))

  it('opens the chat and its tab on click', () => {
    render(<ChatsList project={project} />)
    fireEvent.click(screen.getByTitle('Chat a'))
    expect(mocks.openHistorySession).toHaveBeenCalledWith('a')
    expect(mocks.addAgentChatTab).toHaveBeenCalledWith('a')
  })

  it('toasts and logs once when opening fails', async () => {
    mocks.openHistorySession.mockRejectedValue(new Error('boom'))
    render(<ChatsList project={project} />)
    fireEvent.click(screen.getByTitle('Chat a'))
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Could not open that chat. Try again.')
    )
    expect(mocks.logFrontendError).toHaveBeenCalledTimes(1)
    const logged = mocks.logFrontendError.mock.calls[0][0]
    expect(logged.level).toBe('warn')
    expect(logged.message).not.toContain('Chat a')
  })

  it('opens a terminal at the chat cwd from the hover button', async () => {
    render(<ChatsList project={project} />)
    fireEvent.click(screen.getByTitle('Open terminal at /repo/src'))
    await waitFor(() => expect(mocks.openTerminalAtCwd).toHaveBeenCalledWith('p1', '/repo/src'))
    expect(mocks.addAgentChatTab).not.toHaveBeenCalled()
  })

  it('offers the context menu and deletes after confirmation', async () => {
    render(<ChatsList project={project} />)
    fireEvent.contextMenu(screen.getByTitle('Chat a'))
    fireEvent.click(await screen.findByText('Copy Path'))
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('/repo/src'))

    fireEvent.contextMenu(screen.getByTitle('Chat a'))
    fireEvent.click(await screen.findByText('Delete Chat'))
    expect(mocks.deleteHistorySession).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(mocks.deleteHistorySession).toHaveBeenCalledWith('a')
  })

  it('toasts and logs once when deleting fails', async () => {
    mocks.deleteHistorySession.mockRejectedValue(new Error('nope'))
    render(<ChatsList project={project} />)
    fireEvent.contextMenu(screen.getByTitle('Chat a'))
    fireEvent.click(await screen.findByText('Delete Chat'))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Could not delete that chat. Try again.')
    )
    expect(mocks.logFrontendError).toHaveBeenCalledTimes(1)
  })

  it('makes the card draggable and starts a chat drag on dragstart', () => {
    render(<ChatsList project={project} />)
    const row = screen.getByTitle('Chat a').parentElement as HTMLElement
    expect(row).toHaveAttribute('draggable', 'true')
    fireEvent.dragStart(row)
    expect(mocks.startChatDrag).toHaveBeenCalledTimes(1)
    expect(mocks.startChatDrag.mock.calls[0][0]).toBe('a')
  })

  it('opens the chat in a split to the right of the active pane from the context menu', async () => {
    useWorkspaceStore.setState({ activePaneId: 'pane-7' })
    render(<ChatsList project={project} />)
    fireEvent.contextMenu(screen.getByTitle('Chat a'))
    fireEvent.click(await screen.findByText('Open in split'))
    expect(mocks.openAgentChatPlaced).toHaveBeenCalledWith('a', 'shell-chats-list', {
      paneId: 'pane-7',
      zone: 'right'
    })
    expect(mocks.addAgentChatTab).not.toHaveBeenCalled()
  })

  it('disables Open in split when the chat is the only tab of the active pane', async () => {
    useWorkspaceStore.setState({
      activePaneId: 'pane-1',
      root: {
        type: 'leaf',
        id: 'pane-1',
        tabs: [{ id: 'tab-a', type: 'agent-chat', sessionId: 'a' }],
        activeTabId: 'tab-a'
      }
    } as never)
    render(<ChatsList project={project} />)
    fireEvent.contextMenu(screen.getByTitle('Chat a'))
    const item = await screen.findByRole('menuitem', { name: /Open in split/ })
    expect(item).toHaveAttribute('aria-disabled', 'true')
    expect(item).toHaveTextContent('only tab in the active pane')
    fireEvent.click(item)
    expect(mocks.openAgentChatPlaced).not.toHaveBeenCalled()
  })

  it('moves focus between cards with Up and Down', () => {
    setIndex([entry('a', { lastActivityAt: 2 }), entry('b', { lastActivityAt: 1 })])
    render(<ChatsList project={project} />)
    const [first, second] = cardButtons()
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(second).toHaveFocus()
    fireEvent.keyDown(second, { key: 'ArrowUp' })
    expect(first).toHaveFocus()
  })
})
