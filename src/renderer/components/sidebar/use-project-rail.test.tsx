import { renderHook } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { useProjectRail } from './use-project-rail'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  signals: vi.fn(),
  activity: new Set<string>(),
  errors: new Set<string>(),
  agentChats: [] as string[]
}))

vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useNavigate: () => mocks.navigate
}))
vi.mock('@/hooks/use-agent-chat-attention', () => ({
  useAgentChatProjectSignals: () => mocks.signals()
}))
vi.mock('@/stores/terminal-store', () => ({
  useProjectsWithActivity: () => [...mocks.activity],
  useProjectsWithErrors: () => mocks.errors
}))
vi.mock('@/stores/acp-store', () => ({
  useProjectsWithActiveAgentChat: () => mocks.agentChats
}))

const addAgentChatTab = vi.fn()
const requestFocus = vi.fn()
const onSelectProject = vi.fn()

function renderRail(activeProjectId = 'p1') {
  return renderHook(() => useProjectRail({ activeProjectId, onSelectProject }), {
    wrapper: MemoryRouter
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.activity = new Set()
  mocks.errors = new Set()
  mocks.agentChats = []
  mocks.signals.mockReturnValue({
    attentionCounts: { p2: 2 },
    firstNeedsYouSessionId: { p1: 's1', p2: 's2' },
    runningProjectIds: new Set(['p3'])
  })
  useWorkspaceStore.setState({ addAgentChatTab } as never)
  useAgentChatLifetimeStore.setState({ requestFocus } as never)
})

describe('useProjectRail', () => {
  it('subscribes to the agent chat signals once', () => {
    renderRail()
    expect(mocks.signals).toHaveBeenCalledTimes(1)
  })

  it('resolves live work, needs you and a crash per project', () => {
    mocks.activity = new Set(['p1'])
    mocks.errors = new Set(['p2'])
    const { status } = renderRail().result.current
    expect(status('p1')).toEqual({ live: 'activity', attentionCount: 0, crashed: false })
    expect(status('p2')).toEqual({ live: null, attentionCount: 2, crashed: true })
    expect(status('p3')).toEqual({ live: 'idle-agent', attentionCount: 0, crashed: false })
  })

  it('opens a project: selects it and goes to the workspace', () => {
    renderRail().result.current.openProject('p2')
    expect(onSelectProject).toHaveBeenCalledWith('p2')
    expect(mocks.navigate).toHaveBeenCalledWith('/')
  })

  it('opens the chat that needs you as a tab in the active project', () => {
    renderRail('p1').result.current.openNeedsYou('p1')
    expect(addAgentChatTab).toHaveBeenCalledWith('s1')
    expect(onSelectProject).not.toHaveBeenCalled()
  })

  it('asks another project to focus its chat, then opens the project', () => {
    renderRail('p1').result.current.openNeedsYou('p2')
    expect(requestFocus).toHaveBeenCalledWith('p2', 's2')
    expect(onSelectProject).toHaveBeenCalledWith('p2')
    expect(mocks.navigate).toHaveBeenCalledWith('/')
  })

  it('only opens the project when no chat needs you', () => {
    renderRail('p1').result.current.openNeedsYou('p3')
    expect(requestFocus).not.toHaveBeenCalled()
    expect(onSelectProject).toHaveBeenCalledWith('p3')
  })
})
