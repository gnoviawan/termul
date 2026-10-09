import type { SwitchProjectReply } from '@shared/types/web-projects.types'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _setAcpTransportForTests } from '@/lib/acp-transport'
import type { AcpTransport } from '@/lib/acp-transport/types'
import { logFrontendError } from '@/lib/log-api'
import { mockProject, seedProjectStore } from '@/lib/test-utils/store'
import {
  _resetEphemeralSessionIdsForTesting,
  type AcpSession,
  useAcpStore
} from '@/stores/acp-store'
import { deferred, FRESH } from '@/stores/acp-store/testkit'
import { useConnectionStatusStore } from '@/stores/connection-status-store'
import { useProjectStore } from '@/stores/project-store'
import {
  _resetShellAnnouncerForTests,
  ANNOUNCE_DELAY_MS,
  useShellAnnouncerStore
} from '@/stores/shell-announcer-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import {
  type ProjectSwitchStatus,
  useProjectSwitch,
  useProjectSwitchState
} from './use-project-switch'
import { useShellAnnouncements } from './use-shell-announcements'

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

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

/** Injects a transport whose `switchProject` is the returned spy. */
function setTransport(
  switchProject: (projectId: string) => Promise<SwitchProjectReply>
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(switchProject)
  _setAcpTransportForTests({ switchProject: spy, dispose: vi.fn() } as unknown as AcpTransport)
  return spy
}

const completed: SwitchProjectReply = {
  status: 'completed',
  projectId: 'p2',
  sessionId: 's-new',
  cwd: '/work/p2',
  mcpServerCount: 0
}

/** The shell live region text. */
function region(): string {
  return useShellAnnouncerStore.getState().message
}

/** Lets the announcer's clear-then-set delay elapse. */
function settle(): void {
  act(() => {
    vi.advanceTimersByTime(ANNOUNCE_DELAY_MS)
  })
}

describe('useProjectSwitch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    toastError.mockClear()
    vi.mocked(logFrontendError).mockClear()
    sessionStorage.clear()
    _resetShellAnnouncerForTests()
    useShellAnnouncerStore.setState({ announce: realAnnounce })
    _resetEphemeralSessionIdsForTesting()
    useAcpStore.setState(FRESH)
    useAcpStore.setState({
      agentStatus: { 'agent-1': 'connected' },
      sessions: { active: session('active') },
      activeSessionId: 'active',
      sessionIndex: [],
      failedProjectSwitchId: null
    })
    seedProjectStore(
      [
        mockProject({ id: 'p1', name: 'Alpha', path: '/work/p1' }),
        mockProject({ id: 'p2', name: 'Beta', path: '/work/p2' }),
        mockProject({ id: 'p3', name: 'Gamma', path: '/work/p3' }),
        mockProject({ id: 'p4', name: 'Delta', path: '/work/p4', isArchived: true })
      ],
      'p1'
    )
    useConnectionStatusStore.setState({ controlChannel: 'connected', terminalChannel: 'connected' })
    useWorkspaceStore.setState({
      root: { type: 'leaf', id: 'pane-1', tabs: [], activeTabId: null },
      activePaneId: 'pane-1'
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    _resetEphemeralSessionIdsForTesting()
    _resetShellAnnouncerForTests()
    vi.useRealTimers()
  })

  /** The hook under test with the shell announcer mounted beside it, as the shell does. */
  function mountSwitch(source = 'CommandPalette') {
    return renderHook(() => {
      useShellAnnouncements()
      return useProjectSwitch(source)
    })
  }

  describe('completed', () => {
    it('shows the switch as pending, announces it, then makes the target active', async () => {
      const pending = deferred<SwitchProjectReply>()
      setTransport(() => pending.promise)
      const { result } = mountSwitch()

      let call!: Promise<ProjectSwitchStatus>
      act(() => {
        call = result.current.switchTo('p2')
      })

      // Published before the transport answers, so every surface sees it.
      expect(useAcpStore.getState().switchingProjectId).toBe('p2')
      settle()
      expect(region()).toBe('Switching to Beta…')
      expect(useProjectStore.getState().activeProjectId).toBe('p1')

      await act(async () => {
        pending.resolve(completed)
        await call
      })

      await expect(call).resolves.toBe('completed')
      expect(useAcpStore.getState().switchingProjectId).toBeNull()
      expect(useProjectStore.getState().activeProjectId).toBe('p2')
      expect(useAcpStore.getState().activeSessionId).toBe('s-new')
      expect(toastError).not.toHaveBeenCalled()
      expect(logFrontendError).not.toHaveBeenCalled()
    })
  })

  describe('selected (cold tab)', () => {
    it('selects the project and reports selected', async () => {
      setTransport(async () => ({ status: 'selected', projectId: 'p2' }))
      const { result } = mountSwitch()

      let status: ProjectSwitchStatus | undefined
      await act(async () => {
        status = await result.current.switchTo('p2')
      })

      expect(status).toBe('selected')
      expect(useProjectStore.getState().activeProjectId).toBe('p2')
      expect(useAcpStore.getState().switchingProjectId).toBeNull()
    })
  })

  describe('queued', () => {
    it('records the queued target, clears the pending marker and adds no feedback', async () => {
      setTransport(async () => ({
        status: 'queued',
        projectId: 'p2',
        currentSessionId: 'active'
      }))
      const { result } = mountSwitch()

      let status: ProjectSwitchStatus | undefined
      await act(async () => {
        status = await result.current.switchTo('p2')
      })

      expect(status).toBe('queued')
      expect(useAcpStore.getState().queuedProjectSwitchId).toBe('p2')
      expect(useAcpStore.getState().switchingProjectId).toBeNull()
      // Still on the current project until the turn ends.
      expect(useProjectStore.getState().activeProjectId).toBe('p1')
      expect(toastError).not.toHaveBeenCalled()
      expect(logFrontendError).not.toHaveBeenCalled()
      // Only the "Switching…" announcement from the start; nothing for the queue.
      settle()
      expect(region()).toBe('Switching to Beta…')
    })

    it('ignores another switch while one is queued', async () => {
      const transport = setTransport(async () => ({
        status: 'queued',
        projectId: 'p2',
        currentSessionId: 'active'
      }))
      const { result } = mountSwitch()
      await act(async () => {
        await result.current.switchTo('p2')
      })

      let status: ProjectSwitchStatus | undefined
      await act(async () => {
        status = await result.current.switchTo('p3')
      })

      expect(status).toBe('ignored')
      expect(transport).toHaveBeenCalledTimes(1)
      expect(useAcpStore.getState().queuedProjectSwitchId).toBe('p2')
    })
  })

  describe('rejected', () => {
    it('marks the target failed, toasts the message, logs a warning and announces it', async () => {
      setTransport(async () => {
        throw new Error('switch_project requires a live agent; open a chat first')
      })
      const { result } = mountSwitch()

      let status: ProjectSwitchStatus | undefined
      await act(async () => {
        status = await result.current.switchTo('p2')
      })

      expect(status).toBe('failed')
      expect(useAcpStore.getState().failedProjectSwitchId).toBe('p2')
      expect(useAcpStore.getState().switchingProjectId).toBeNull()
      expect(toastError).toHaveBeenCalledTimes(1)
      expect(toastError).toHaveBeenCalledWith(
        'switch_project requires a live agent; open a chat first'
      )
      expect(logFrontendError).toHaveBeenCalledTimes(1)
      expect(logFrontendError).toHaveBeenCalledWith({
        level: 'warn',
        source: 'CommandPalette',
        message:
          'Project switch failed for p2: switch_project requires a live agent; open a chat first'
      })
      expect(useProjectStore.getState().activeProjectId).toBe('p1')
      settle()
      expect(region()).toBe("Couldn't switch to Beta")
    })

    it('names the caller in the log', async () => {
      setTransport(async () => {
        throw new Error('boom')
      })
      const { result } = mountSwitch('ProjectSwitcherDrawer')

      await act(async () => {
        await result.current.switchTo('p3')
      })

      expect(logFrontendError).toHaveBeenCalledWith({
        level: 'warn',
        source: 'ProjectSwitcherDrawer',
        message: 'Project switch failed for p3: boom'
      })
    })

    it('stringifies a rejection that is not an Error', async () => {
      setTransport(() => Promise.reject('plain failure'))
      const { result } = mountSwitch()

      await act(async () => {
        await result.current.switchTo('p2')
      })

      expect(toastError).toHaveBeenCalledWith('plain failure')
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Project switch failed for p2: plain failure' })
      )
    })

    it('fails when the transport cannot switch projects at all', async () => {
      _setAcpTransportForTests({ dispose: vi.fn() } as unknown as AcpTransport)
      const { result } = mountSwitch()

      let status: ProjectSwitchStatus | undefined
      await act(async () => {
        status = await result.current.switchTo('p2')
      })

      expect(status).toBe('failed')
      expect(toastError).toHaveBeenCalledWith(
        'Project switching is only available in web/remote mode'
      )
    })

    it('lets a retry run: a fresh attempt clears the failed marker', async () => {
      let attempts = 0
      setTransport(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('boom')
        return completed
      })
      const { result } = mountSwitch()
      await act(async () => {
        await result.current.switchTo('p2')
      })
      expect(useAcpStore.getState().failedProjectSwitchId).toBe('p2')

      let status: ProjectSwitchStatus | undefined
      await act(async () => {
        status = await result.current.switchTo('p2')
      })

      expect(status).toBe('completed')
      expect(useAcpStore.getState().failedProjectSwitchId).toBeNull()
    })
  })

  describe('ignored', () => {
    it('ignores a second switch while one is in flight', async () => {
      const pending = deferred<SwitchProjectReply>()
      const transport = setTransport(() => pending.promise)
      const { result } = mountSwitch()
      let first!: Promise<ProjectSwitchStatus>
      act(() => {
        first = result.current.switchTo('p2')
      })

      let status: ProjectSwitchStatus | undefined
      await act(async () => {
        status = await result.current.switchTo('p3')
      })

      expect(status).toBe('ignored')
      expect(transport).toHaveBeenCalledTimes(1)
      expect(useAcpStore.getState().switchingProjectId).toBe('p2')

      await act(async () => {
        pending.resolve(completed)
        await first
      })
    })

    it('ignores two taps in the same tick', async () => {
      const pending = deferred<SwitchProjectReply>()
      const transport = setTransport(() => pending.promise)
      const { result } = mountSwitch()

      let statuses: ProjectSwitchStatus[] = []
      act(() => {
        const taps = [result.current.switchTo('p2'), result.current.switchTo('p2')]
        void Promise.all(taps).then((all) => {
          statuses = all
        })
      })
      await act(async () => {
        pending.resolve(completed)
        await Promise.resolve()
      })
      await act(async () => {
        await Promise.resolve()
      })

      expect(transport).toHaveBeenCalledTimes(1)
      expect(statuses).toEqual(['completed', 'ignored'])
    })

    it.each([
      ['the active project', 'p1'],
      ['an archived project', 'p4'],
      ['an unknown project', 'nope']
    ])('ignores %s without touching the store', async (_label, projectId) => {
      const transport = setTransport(async () => completed)
      const { result } = mountSwitch()

      let status: ProjectSwitchStatus | undefined
      await act(async () => {
        status = await result.current.switchTo(projectId)
      })

      expect(status).toBe('ignored')
      expect(transport).not.toHaveBeenCalled()
      expect(useAcpStore.getState().switchingProjectId).toBeNull()
      expect(useAcpStore.getState().failedProjectSwitchId).toBeNull()
      expect(useProjectStore.getState().activeProjectId).toBe('p1')
      expect(toastError).not.toHaveBeenCalled()
      settle()
      expect(region()).toBe('')
    })
  })

  describe('clearFailed', () => {
    it('dismisses the failed marker', () => {
      useAcpStore.setState({ failedProjectSwitchId: 'p2' })
      const { result } = mountSwitch()

      act(() => {
        result.current.clearFailed()
      })

      expect(useAcpStore.getState().failedProjectSwitchId).toBeNull()
    })
  })

  describe('stability', () => {
    it('returns the same functions across renders and store changes', () => {
      const { result, rerender } = mountSwitch()
      const first = result.current

      rerender()
      act(() => {
        useAcpStore.setState({ switchingProjectId: 'p2' })
        useProjectStore.setState({ activeProjectId: 'p3' })
      })
      rerender()

      expect(result.current).toBe(first)
      expect(result.current.switchTo).toBe(first.switchTo)
      expect(result.current.clearFailed).toBe(first.clearFailed)
    })
  })
})

describe('useProjectSwitchState', () => {
  beforeEach(() => {
    useAcpStore.setState(FRESH)
    useAcpStore.setState({ failedProjectSwitchId: null })
  })

  it('is idle with no markers', () => {
    const { result } = renderHook(() => useProjectSwitchState())

    expect(result.current).toEqual({
      switchingId: null,
      queuedId: null,
      failedId: null,
      busy: false
    })
  })

  it('follows the store and is busy while switching or queued, but not when only failed', () => {
    const { result } = renderHook(() => useProjectSwitchState())

    act(() => {
      useAcpStore.setState({ switchingProjectId: 'p2' })
    })
    expect(result.current).toMatchObject({ switchingId: 'p2', busy: true })

    act(() => {
      useAcpStore.setState({ switchingProjectId: null, queuedProjectSwitchId: 'p2' })
    })
    expect(result.current).toMatchObject({ switchingId: null, queuedId: 'p2', busy: true })

    act(() => {
      useAcpStore.setState({ queuedProjectSwitchId: null, failedProjectSwitchId: 'p2' })
    })
    expect(result.current).toEqual({
      switchingId: null,
      queuedId: null,
      failedId: 'p2',
      busy: false
    })
  })
})
