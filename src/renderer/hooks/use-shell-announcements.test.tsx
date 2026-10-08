import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { logFrontendError } from '@/lib/log-api'
import { mockProject, seedProjectStore } from '@/lib/test-utils/store'
import {
  _addEphemeralSessionIdForTesting,
  _resetEphemeralSessionIdsForTesting,
  type AcpSession,
  useAcpStore
} from '@/stores/acp-store'
import { FRESH } from '@/stores/acp-store/testkit'
import { useAgentChatLifetimeStore } from '@/stores/agent-chat-lifetime-store'
import { useConnectionStatusStore } from '@/stores/connection-status-store'
import { useProjectStore } from '@/stores/project-store'
import {
  _resetShellAnnouncerForTests,
  ANNOUNCE_DELAY_MS,
  useShellAnnouncerStore
} from '@/stores/shell-announcer-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { LeafNode } from '@/types/workspace.types'
import { useShellAnnouncements } from './use-shell-announcements'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

/** The real `announce`, restored before each test because failure tests replace it. */
const realAnnounce = useShellAnnouncerStore.getState().announce

function session(id: string, overrides: Partial<AcpSession> = {}): AcpSession {
  return {
    id,
    agentId: 'agent-1',
    cwd: '/work',
    projectId: 'p1',
    status: 'active',
    title: `Title ${id}`,
    activeTurn: false,
    openTurnId: null,
    modes: null,
    models: null,
    configOptions: [],
    lastError: null,
    createdAt: 1,
    ...overrides
  }
}

function seedSessions(overrides: Record<string, Partial<AcpSession>> = {}): void {
  useAcpStore.setState({
    sessions: {
      active: session('active', overrides.active),
      other: session('other', overrides.other)
    }
  })
}

function setActiveChat(sessionId: 'active' | 'other'): void {
  const leaf: LeafNode = {
    type: 'leaf',
    id: 'pane-1',
    tabs: [
      { type: 'agent-chat', id: 'tab-active', sessionId: 'active' },
      { type: 'agent-chat', id: 'tab-other', sessionId: 'other' }
    ],
    activeTabId: sessionId === 'active' ? 'tab-active' : 'tab-other'
  }
  useWorkspaceStore.setState({ root: leaf, activePaneId: 'pane-1' })
}

function permission(requestId: string, sessionId: string): Record<string, unknown> {
  return {
    [requestId]: { requestId, agentId: 'agent-1', sessionId, options: [], toolCall: null }
  }
}

function region(): string {
  return useShellAnnouncerStore.getState().message
}

/** Let the announcer's clear-then-set delay elapse. */
function settle(): void {
  act(() => {
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS)
  })
}

describe('useShellAnnouncements', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(logFrontendError).mockClear()
    _resetShellAnnouncerForTests()
    useShellAnnouncerStore.setState({ announce: realAnnounce })
    _resetEphemeralSessionIdsForTesting()
    useAcpStore.setState(FRESH)
    useAcpStore.setState({
      agentStatus: { 'agent-1': 'connected' },
      sessionIndex: [],
      failedProjectSwitchId: null
    })
    seedSessions()
    seedProjectStore(
      [
        mockProject({ id: 'p1', name: 'Alpha' }),
        mockProject({ id: 'p2', name: 'Beta' }),
        mockProject({ id: 'p3', name: '' })
      ],
      'p1'
    )
    useAgentChatLifetimeStore.setState({ retainedByProject: {} })
    useConnectionStatusStore.setState({ controlChannel: 'connected', terminalChannel: 'connected' })
    setActiveChat('active')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    _resetEphemeralSessionIdsForTesting()
    _resetShellAnnouncerForTests()
    vi.useRealTimers()
  })

  describe('region lifecycle', () => {
    it('registers the region on mount and resets it on unmount', () => {
      const { unmount } = renderHook(() => useShellAnnouncements())
      expect(useShellAnnouncerStore.getState().regionCount).toBe(1)

      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r1', 'active') })
      })
      settle()
      expect(region()).toBe('Approval needed')

      unmount()
      expect(useShellAnnouncerStore.getState().regionCount).toBe(0)
      expect(region()).toBe('')
    })

    it('stops listening after unmount', () => {
      const { unmount } = renderHook(() => useShellAnnouncements())
      unmount()
      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r1', 'active') })
        useConnectionStatusStore.setState({ controlChannel: 'disconnected' })
      })
      settle()
      expect(region()).toBe('')
      expect(logFrontendError).not.toHaveBeenCalled()
    })
  })

  describe('baseline', () => {
    it('is silent when the shell mounts while chats need you and approvals are pending', () => {
      useAcpStore.setState({
        pendingPermissions: permission('r1', 'active'),
        pendingQuestions: {
          q1: {
            questionId: 'q1',
            agentId: 'agent-1',
            sessionId: 'other',
            question: '?',
            options: []
          }
        }
      })
      useConnectionStatusStore.setState({ controlChannel: 'reconnecting' })
      renderHook(() => useShellAnnouncements())
      settle()
      expect(region()).toBe('')
    })

    it('is silent when a session is first seen already needing you', () => {
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({
          sessions: {
            active: session('active'),
            other: session('other'),
            third: session('third')
          },
          pendingPermissions: permission('r1', 'third')
        })
        useWorkspaceStore.setState({
          root: {
            type: 'leaf',
            id: 'pane-1',
            tabs: [
              { type: 'agent-chat', id: 'tab-active', sessionId: 'active' },
              { type: 'agent-chat', id: 'tab-third', sessionId: 'third' }
            ],
            activeTabId: 'tab-active'
          }
        })
      })
      settle()
      expect(region()).toBe('')
    })
  })

  describe('approvals', () => {
    it.each([
      ['permission', () => ({ pendingPermissions: permission('r1', 'active') })],
      [
        'question',
        () => ({
          pendingQuestions: {
            q1: {
              questionId: 'q1',
              agentId: 'agent-1',
              sessionId: 'active',
              question: 'Which one?',
              options: []
            }
          }
        })
      ],
      [
        'elicitation',
        () => ({
          pendingElicitations: {
            e1: {
              requestId: 'e1',
              agentId: 'agent-1',
              sessionId: 'active',
              mode: 'form',
              message: 'Fill this in',
              fields: []
            }
          }
        })
      ]
    ] satisfies Array<
      [string, () => Partial<ReturnType<typeof useAcpStore.getState>>]
    >)('announces a new %s in the active chat', (_, patch) => {
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState(patch())
      })
      settle()
      expect(region()).toBe('Approval needed')
    })

    it('announces a second approval for the active chat', () => {
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r1', 'active') })
      })
      settle()
      act(() => {
        useAcpStore.setState({
          pendingPermissions: { ...permission('r1', 'active'), ...permission('r2', 'active') }
        })
      })
      expect(region()).toBe('')
      settle()
      expect(region()).toBe('Approval needed')
    })

    it('does not announce Approval needed when a permission disappears with a disconnect', () => {
      useAcpStore.setState({ pendingPermissions: permission('r1', 'active') })
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({
          pendingPermissions: {},
          agentStatus: { 'agent-1': 'disconnected' }
        })
      })
      settle()
      // The permission key just disappears, so the denial itself is silent. What is
      // announced is the other chat of the disconnected agent that now needs you.
      expect(region()).toBe('Title other needs you')
    })
  })

  describe('other chat needs you', () => {
    it('announces a chat in the active project with its live title', () => {
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r1', 'other') })
      })
      settle()
      expect(region()).toBe('Title other needs you')
    })

    it('falls back to the session-index title, then Agent Chat', () => {
      seedSessions({ other: { title: null } })
      useAcpStore.setState({
        sessionIndex: [
          {
            id: 'other',
            agentId: 'agent-1',
            agentConfigId: 'cfg-1',
            title: 'Indexed title',
            cwd: '/work',
            projectId: 'p1',
            createdAt: 1,
            lastActivityAt: 1,
            messageCount: 1,
            status: 'active'
          }
        ]
      })
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r1', 'other') })
      })
      settle()
      expect(region()).toBe('Indexed title needs you')

      act(() => {
        useAcpStore.setState({ pendingPermissions: {}, sessionIndex: [] })
      })
      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r2', 'other') })
      })
      settle()
      expect(region()).toBe('Agent Chat needs you')
    })

    it('counts retained chats that have no open tab', () => {
      useAcpStore.setState({
        sessions: { active: session('active'), other: session('other'), kept: session('kept') }
      })
      useAgentChatLifetimeStore.setState({ retainedByProject: { p1: ['kept'] } })
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r1', 'kept') })
      })
      settle()
      expect(region()).toBe('Title kept needs you')
    })

    it('is silent for a second permission on a chat that already needs you', () => {
      useAcpStore.setState({ pendingPermissions: permission('r1', 'other') })
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({
          pendingPermissions: { ...permission('r1', 'other'), ...permission('r2', 'other') }
        })
      })
      settle()
      expect(region()).toBe('')
    })

    it('is silent when a needs-you chat stops being the active one', () => {
      useAcpStore.setState({ pendingPermissions: permission('r1', 'active') })
      renderHook(() => useShellAnnouncements())
      act(() => {
        setActiveChat('other')
        // Any relevant store write re-evaluates with the new active chat.
        useAcpStore.setState({ sessions: { ...useAcpStore.getState().sessions } })
      })
      settle()
      expect(region()).toBe('')
    })

    it('is silent for a chat in another project', () => {
      useAcpStore.setState({
        sessions: {
          active: session('active'),
          other: session('other'),
          far: session('far', { projectId: 'p2' })
        }
      })
      useAgentChatLifetimeStore.setState({ retainedByProject: { p2: ['far'] } })
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r1', 'far') })
      })
      settle()
      expect(region()).toBe('')
    })

    it('is silent for another chat holding an elicitation', () => {
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({
          pendingElicitations: {
            e1: {
              requestId: 'e1',
              agentId: 'agent-1',
              sessionId: 'other',
              mode: 'form',
              message: 'Fill this in',
              fields: []
            }
          }
        })
      })
      settle()
      expect(region()).toBe('')
    })

    it('ignores ephemeral warm-up sessions', () => {
      _addEphemeralSessionIdForTesting('other')
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r1', 'other') })
      })
      settle()
      expect(region()).toBe('')
    })
  })

  describe('turn finished', () => {
    it('announces when the active chat turn ends', () => {
      seedSessions({ active: { activeTurn: true, openTurnId: 't1' } })
      renderHook(() => useShellAnnouncements())
      act(() => {
        seedSessions({ active: { activeTurn: false, openTurnId: null } })
      })
      settle()
      expect(region()).toBe('Turn finished')
    })

    it('is silent when a turn ends in a chat that is not active', () => {
      seedSessions({ other: { activeTurn: true, openTurnId: 't1' } })
      renderHook(() => useShellAnnouncements())
      act(() => {
        seedSessions({ other: { activeTurn: false, openTurnId: null } })
      })
      settle()
      expect(region()).toBe('')
    })

    it('is silent when the user switches from a running chat to another chat', () => {
      seedSessions({ active: { activeTurn: true, openTurnId: 't1' } })
      renderHook(() => useShellAnnouncements())
      act(() => {
        setActiveChat('other')
        useAcpStore.setState({ sessions: { ...useAcpStore.getState().sessions } })
      })
      settle()
      expect(region()).toBe('')
    })
  })

  describe('connection', () => {
    it('announces control channel loss and recovery', () => {
      renderHook(() => useShellAnnouncements())
      act(() => {
        useConnectionStatusStore.setState({ controlChannel: 'reconnecting' })
      })
      settle()
      expect(region()).toBe('Reconnecting…')

      act(() => {
        useConnectionStatusStore.setState({ controlChannel: 'disconnected' })
      })
      settle()
      expect(region()).toBe('Disconnected')

      act(() => {
        useConnectionStatusStore.setState({ controlChannel: 'connected' })
      })
      settle()
      expect(region()).toBe('Connected')
    })

    it('announces terminal channel loss and recovery', () => {
      renderHook(() => useShellAnnouncements())
      act(() => {
        useConnectionStatusStore.setState({ terminalChannel: 'disconnected' })
      })
      settle()
      expect(region()).toBe('Disconnected')
      act(() => {
        useConnectionStatusStore.setState({ terminalChannel: 'connected' })
      })
      settle()
      expect(region()).toBe('Connected')
    })

    it('is silent for the boot connect and for the lazy terminal connect', () => {
      useConnectionStatusStore.setState({ controlChannel: 'connecting' })
      renderHook(() => useShellAnnouncements())
      act(() => {
        useConnectionStatusStore.setState({ controlChannel: 'connected' })
      })
      settle()
      expect(region()).toBe('')

      act(() => {
        useConnectionStatusStore.setState({ terminalChannel: 'connecting' })
      })
      act(() => {
        useConnectionStatusStore.setState({ terminalChannel: 'connected' })
      })
      settle()
      expect(region()).toBe('')
    })
  })

  describe('project switch', () => {
    it('announces a switch in flight with the project-store name', () => {
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({ switchingProjectId: 'p2' })
      })
      settle()
      expect(region()).toBe('Switching to Beta…')

      act(() => {
        useAcpStore.setState({ switchingProjectId: null })
      })
      settle()
      expect(region()).toBe('Switching to Beta…')
    })

    it('falls back to the project id when the store has no name', () => {
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({ switchingProjectId: 'p3' })
      })
      settle()
      expect(region()).toBe('Switching to p3…')

      act(() => {
        useAcpStore.setState({ switchingProjectId: 'unknown-project' })
      })
      settle()
      expect(region()).toBe('Switching to unknown-project…')
    })

    it('announces a failure even when it is cleared again in the same tick', () => {
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({ failedProjectSwitchId: 'p2' })
        useAcpStore.setState({ failedProjectSwitchId: null })
      })
      settle()
      expect(region()).toBe("Couldn't switch to Beta")
    })
  })

  describe('queue behaviour', () => {
    it('shows only the newest of two back-to-back announcements', () => {
      renderHook(() => useShellAnnouncements())
      act(() => {
        useAcpStore.setState({ switchingProjectId: 'p2' })
      })
      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r1', 'active') })
      })
      settle()
      expect(region()).toBe('Approval needed')
    })

    it('lets Approval needed win when it lands with a switch, a turn end and a needs-you', () => {
      seedSessions({ active: { activeTurn: true, openTurnId: 't1' } })
      renderHook(() => useShellAnnouncements())
      act(() => {
        seedSessions({ active: { activeTurn: false, openTurnId: null } })
      })
      // Land everything in one write.
      act(() => {
        useAcpStore.setState({
          switchingProjectId: 'p2',
          pendingPermissions: { ...permission('r1', 'active'), ...permission('r2', 'other') }
        })
      })
      settle()
      expect(region()).toBe('Approval needed')
    })

    it('re-announces the same text twice by clearing the region in between', () => {
      renderHook(() => useShellAnnouncements())
      const seen: string[] = []
      const unsubscribe = useShellAnnouncerStore.subscribe((state) => seen.push(state.message))

      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r1', 'active') })
      })
      settle()
      act(() => {
        useAcpStore.setState({ pendingPermissions: {} })
      })
      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r2', 'active') })
      })
      settle()
      unsubscribe()

      expect(seen.filter((message) => message !== '')).toEqual([
        'Approval needed',
        'Approval needed'
      ])
      expect(seen).toContain('')
    })
  })

  describe('failure handling', () => {
    it('logs a warn and never throws into the store write when a subscriber throws', () => {
      renderHook(() => useShellAnnouncements())
      useShellAnnouncerStore.setState({
        announce: () => {
          throw new Error('announce exploded')
        }
      })

      expect(() => {
        act(() => {
          useAcpStore.setState({ pendingPermissions: permission('r1', 'active') })
        })
      }).not.toThrow()

      // The triggering write still completed.
      expect(Object.keys(useAcpStore.getState().pendingPermissions)).toEqual(['r1'])
      expect(logFrontendError).toHaveBeenCalledTimes(1)
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          source: 'shell-announcer',
          message: expect.stringContaining('announce exploded')
        })
      )
    })

    it('logs a warn for a throwing connection subscriber too', () => {
      renderHook(() => useShellAnnouncements())
      useShellAnnouncerStore.setState({
        announce: () => {
          throw new Error('announce exploded')
        }
      })

      expect(() => {
        act(() => {
          useConnectionStatusStore.setState({ controlChannel: 'disconnected' })
        })
      }).not.toThrow()
      expect(useConnectionStatusStore.getState().controlChannel).toBe('disconnected')
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'warn', source: 'shell-announcer' })
      )
    })

    it('does not log chat titles or user content', () => {
      seedSessions({ other: { title: 'Secret roadmap' } })
      renderHook(() => useShellAnnouncements())
      useShellAnnouncerStore.setState({
        announce: () => {
          throw new Error('announce exploded')
        }
      })
      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r1', 'other') })
      })
      const logged = JSON.stringify(vi.mocked(logFrontendError).mock.calls)
      expect(logged).not.toContain('Secret roadmap')
    })

    it('keeps evaluating after one evaluation failed', () => {
      renderHook(() => useShellAnnouncements())
      const getState = vi.spyOn(useProjectStore, 'getState').mockImplementationOnce(() => {
        throw new Error('project store unavailable')
      })

      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r1', 'active') })
      })
      expect(logFrontendError).toHaveBeenCalledTimes(1)
      getState.mockRestore()

      act(() => {
        useAcpStore.setState({ pendingPermissions: {} })
      })
      act(() => {
        useAcpStore.setState({ pendingPermissions: permission('r2', 'active') })
      })
      settle()
      expect(region()).toBe('Approval needed')
    })
  })

  describe('early exit', () => {
    it('does not evaluate when no relevant slice changed', () => {
      renderHook(() => useShellAnnouncements())
      const workspaceRead = vi.spyOn(useWorkspaceStore, 'getState')

      act(() => {
        useAcpStore.setState({ messages: { active: [] } })
        useConnectionStatusStore.setState({ controlChannel: 'connected' })
      })

      expect(workspaceRead).not.toHaveBeenCalled()
    })

    it('evaluates when a relevant slice changes', () => {
      renderHook(() => useShellAnnouncements())
      const workspaceRead = vi.spyOn(useWorkspaceStore, 'getState')

      act(() => {
        useAcpStore.setState({ switchingProjectId: 'p2' })
      })

      expect(workspaceRead).toHaveBeenCalled()
    })
  })
})
