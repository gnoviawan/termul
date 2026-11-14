import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { mockSessionIndexEntry } from '@/lib/test-utils/acp'
import { resetChatActivity, seedChatActivity } from '@/lib/test-utils/chat-activity'
import { useAcpStore } from '@/stores/acp-store'
import { resetShellLayoutStoreForTests, useShellLayoutStore } from '@/stores/shell-layout-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import type { ChatCardData } from './chat-cards'
import { isOpenChatCard, liveStateOf, useChatLiveState, useProjectChats } from './use-project-chats'

const project = {
  id: 'p1',
  name: 'Alpha',
  path: '/repo',
  color: 'blue',
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
  mockSessionIndexEntry({ id, title: `Chat ${id}`, cwd: '/repo', projectId: 'p1', ...overrides })

const openTab = (sessionId: string) =>
  useWorkspaceStore.setState({
    activePaneId: 'pane-1',
    root: {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'tab', type: 'agent-chat', sessionId }],
      activeTabId: 'tab'
    }
  } as never)

beforeEach(() => {
  resetShellLayoutStoreForTests()
  useShellLayoutStore.setState({ status: 'ready' })
  resetChatActivity()
  useAcpStore.setState({ sessionIndex: [], sessions: {}, agentConfigs: [] })
  useWorkspaceStore.setState({
    activePaneId: 'pane-1',
    root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null }
  } as never)
})

describe('useProjectChats', () => {
  it('returns the project chats newest first, scoped by the worktree pick', () => {
    useAcpStore.setState({
      sessionIndex: [
        entry('a', { lastActivityAt: 1 }),
        entry('b', { lastActivityAt: 3, cwd: '/repo/.termul/worktrees/feature' }),
        entry('x', { projectId: 'p2', lastActivityAt: 9 })
      ]
    })
    const { result } = renderHook(() => useProjectChats(project))
    expect(result.current.cards.map((card) => card.entry.id)).toEqual(['b', 'a'])

    act(() => {
      useShellLayoutStore.setState({
        worktreePickByProject: { p1: '/repo/.termul/worktrees/feature' }
      })
    })
    expect(result.current.cards.map((card) => card.entry.id)).toEqual(['b'])
  })

  it('reports the chat open in the active pane', () => {
    const { result } = renderHook(() => useProjectChats(project))
    expect(result.current.openChatId).toBeNull()
    act(() => openTab('a'))
    expect(result.current.openChatId).toBe('a')
  })
})

describe('isOpenChatCard', () => {
  const card = { entry: { id: 'b', chainIds: ['a', 'b'] } } as unknown as ChatCardData
  it('matches the card or any session of its chain', () => {
    expect(isOpenChatCard(card, 'b')).toBe(true)
    expect(isOpenChatCard(card, 'a')).toBe(true)
    expect(isOpenChatCard(card, 'c')).toBe(false)
    expect(isOpenChatCard(card, null)).toBe(false)
  })
})

describe('chat live state', () => {
  it('ranks needs-you over running over done', () => {
    expect(liveStateOf({ needsAttention: true, turnBusy: true, unread: true })).toBe('needs-you')
    expect(liveStateOf({ needsAttention: false, turnBusy: true, unread: true })).toBe('running')
    expect(liveStateOf({ needsAttention: false, turnBusy: false, unread: true })).toBe('done')
    expect(liveStateOf({ needsAttention: false, turnBusy: false, unread: false })).toBe('idle')
  })

  it('reads the host chat activity with a status word', () => {
    seedChatActivity({ a: { busy: true } })
    const { result } = renderHook(() => useChatLiveState('a'))
    expect(result.current.liveState).toBe('running')
    expect(result.current.statusWord).toBe('Running')
  })
})
