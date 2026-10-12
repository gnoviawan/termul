import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockProject, seedProjectStore } from '@/lib/test-utils/store'
import { getTabFocusedSessionId, setTabFocusedSessionId } from '@/lib/web-tab-session'
import { _resetEphemeralSessionIdsForTesting, useAcpStore } from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useProjectStore } from '@/stores/project-store'
import { useProjectSwitch } from './use-project-switch'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

function indexEntry(id: string, projectId: string, lastActivityAt: number, discovered = false) {
  return {
    id,
    agentId: 'agent-1',
    title: id,
    cwd: '/work',
    projectId,
    createdAt: 1,
    lastActivityAt,
    messageCount: 1,
    status: 'closed' as const,
    discovered
  }
}

describe('useProjectSwitch (client-only)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    _resetEphemeralSessionIdsForTesting()
    useAcpStore.setState(FRESH)
    useAgentChatLifetimeStore.setState({
      retainedByProject: {},
      activeSessionByProject: {},
      focusSessionByProject: {}
    })
    seedProjectStore(
      [
        mockProject({ id: 'p1', name: 'Alpha', path: '/work/p1' }),
        mockProject({ id: 'p2', name: 'Beta', path: '/work/p2' }),
        mockProject({ id: 'p3', name: 'Gamma', path: '/work/p3', isArchived: true })
      ],
      'p1'
    )
  })

  it('selects the target project without any host call', () => {
    const { result } = renderHook(() => useProjectSwitch('test'))

    expect(result.current.switchTo('p2')).toBe('selected')
    expect(useProjectStore.getState().activeProjectId).toBe('p2')
  })

  it.each([
    ['unknown', 'nope'],
    ['archived', 'p3'],
    ['already active', 'p1']
  ])('ignores a %s target', (_label, projectId) => {
    const { result } = renderHook(() => useProjectSwitch('test'))

    expect(result.current.switchTo(projectId)).toBe('ignored')
    expect(useProjectStore.getState().activeProjectId).toBe('p1')
  })

  it('clears the focus pointers that still name the previous project chat', () => {
    useAcpStore.setState({
      sessionIndex: [indexEntry('s-p1', 'p1', 5)],
      activeSessionId: 's-p1'
    })
    setTabFocusedSessionId('s-p1')
    const { result } = renderHook(() => useProjectSwitch('test'))

    result.current.switchTo('p2')

    expect(useAcpStore.getState().activeSessionId).toBeNull()
    expect(getTabFocusedSessionId()).toBeNull()
  })

  it('keeps the focus pointers of an unassigned chat (it belongs to no project)', () => {
    useAcpStore.setState({
      sessionIndex: [indexEntry('s-un', '__unassigned__', 5)],
      activeSessionId: 's-un'
    })
    const { result } = renderHook(() => useProjectSwitch('test'))

    result.current.switchTo('p2')

    expect(useAcpStore.getState().activeSessionId).toBe('s-un')
  })

  it("requests the target project's most recent persisted chat when it has none to come back to", () => {
    useAcpStore.setState({
      sessionIndex: [
        indexEntry('old', 'p2', 1),
        indexEntry('newest', 'p2', 9),
        indexEntry('mirror', 'p2', 99, true),
        indexEntry('other-project', 'p1', 100)
      ]
    })
    const { result } = renderHook(() => useProjectSwitch('test'))

    result.current.switchTo('p2')

    const lifetime = useAgentChatLifetimeStore.getState()
    expect(lifetime.focusSessionByProject.p2).toBe('newest')
    expect(lifetime.retainedByProject.p2).toEqual(['newest'])
  })

  it('leaves a chat the user already had open in the target project to win', () => {
    useAcpStore.setState({ sessionIndex: [indexEntry('newest', 'p2', 9)] })
    useAgentChatLifetimeStore.getState().retainProjectChats('p2', ['kept'])
    useAgentChatLifetimeStore.getState().rememberActiveChat('p2', 'kept')
    const { result } = renderHook(() => useProjectSwitch('test'))

    result.current.switchTo('p2')

    const lifetime = useAgentChatLifetimeStore.getState()
    expect(lifetime.focusSessionByProject.p2).toBeUndefined()
    expect(lifetime.retainedByProject.p2).toEqual(['kept'])
  })
})
