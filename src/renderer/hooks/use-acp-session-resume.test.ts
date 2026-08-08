import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Records of continuity events so the resume boundaries (R6) are asserted as
// regression gates.
const events: { name: string; terminalId?: string; details?: Record<string, unknown> }[] = []

const transportMocks = {
  fetchSessionCursor: vi.fn(),
  seedSessionCursor: vi.fn()
}

const state: {
  sessionIndex: Array<{
    id: string
    agentId: string
    agentConfigId?: string
    cwd: string
    projectId: string
    status: 'initializing' | 'active' | 'error' | 'closed'
  }>
  resumeLiveSession: ReturnType<typeof vi.fn>
  flushLiveSessionSaves: ReturnType<typeof vi.fn>
  sessions: Record<string, { status: string }>
} = {
  sessionIndex: [],
  resumeLiveSession: vi.fn(),
  flushLiveSessionSaves: vi.fn(),
  sessions: {}
}

vi.mock('@/stores/acp-store', () => ({
  // zustand `useStore(selector)` shape + `.getState()` accessor.
  useAcpStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: Object.assign(
    (selector: (s: { activeProjectId: string }) => unknown) => selector({ activeProjectId: 'p1' }),
    { getState: () => ({ activeProjectId: 'p1' }) }
  )
}))

vi.mock('@/lib/acp-transport', () => ({
  getAcpTransport: () => transportMocks
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/lib/terminal-continuity-instrumentation', () => ({
  getOrCreateProjectContinuityCorrelation: vi.fn().mockReturnValue('corr-1'),
  recordTerminalContinuityEvent: vi.fn(
    (event: { name: string; terminalId?: string; details?: Record<string, unknown> }) => {
      events.push(event)
      return { ...event, timestamp: new Date().toISOString() }
    }
  )
}))

import { useAcpSessionResume } from './use-acp-session-resume'

function eligibleSession(overrides: Partial<(typeof state.sessionIndex)[number]> = {}) {
  return {
    id: 's1',
    agentId: 'agent-1',
    agentConfigId: 'config:claude',
    cwd: '/repo',
    projectId: 'p1',
    status: 'active' as const,
    ...overrides
  }
}

describe('useAcpSessionResume — refresh reattachment (R1/R2/R6)', () => {
  beforeEach(() => {
    events.length = 0
    transportMocks.fetchSessionCursor.mockReset()
    transportMocks.seedSessionCursor.mockReset()
    state.resumeLiveSession.mockReset()
    state.flushLiveSessionSaves.mockReset()
    state.sessionIndex = []
    state.sessions = {}
  })

  it('resumes a still-running turn with the server cursor + records succeeded', async () => {
    state.sessionIndex = [eligibleSession()]
    transportMocks.fetchSessionCursor.mockResolvedValue(7)
    state.resumeLiveSession.mockResolvedValue(undefined)

    renderHook(() => useAcpSessionResume())

    await waitFor(() => {
      expect(state.resumeLiveSession).toHaveBeenCalledWith('s1', 'agent-1', '/repo')
    })
    // R2: server-authoritative cursor seeded before resume (web parity).
    expect(transportMocks.fetchSessionCursor).toHaveBeenCalledWith('s1')
    expect(transportMocks.seedSessionCursor).toHaveBeenCalledWith('s1', 7)
    expect(events.find((e) => e.name === 'acp-resume-attempted')?.terminalId).toBe('s1')
    expect(events.find((e) => e.name === 'acp-resume-succeeded')?.terminalId).toBe('s1')
    expect(events.some((e) => e.name === 'acp-resume-skipped')).toBe(false)
  })

  it('records skipped (no throw) when the agent has exited / capability is absent', async () => {
    // The backend `gate_resume_session` rejects (agent exited or no resume
    // capability) → `resumeLiveSession` rejects → read-only local, no spawn.
    state.sessionIndex = [eligibleSession()]
    transportMocks.fetchSessionCursor.mockResolvedValue(3)
    state.resumeLiveSession.mockRejectedValue(new Error('resume not supported'))

    renderHook(() => useAcpSessionResume())

    await waitFor(() => {
      expect(events.some((e) => e.name === 'acp-resume-skipped')).toBe(true)
    })
    expect(events.some((e) => e.name === 'acp-resume-succeeded')).toBe(false)
    expect(state.resumeLiveSession).toHaveBeenCalledTimes(1)
    // Hook never throws on the bootstrap path (best-effort).
    expect(events.find((e) => e.name === 'acp-resume-skipped')?.terminalId).toBe('s1')
  })

  it('honors the project scope + skips closed chats', async () => {
    state.sessionIndex = [
      eligibleSession({ id: 'in-project', status: 'active' }),
      eligibleSession({ id: 'other-project', projectId: 'p2' }),
      eligibleSession({ id: 'closed', status: 'closed' })
    ]
    transportMocks.fetchSessionCursor.mockResolvedValue(0)
    state.resumeLiveSession.mockResolvedValue(undefined)

    renderHook(() => useAcpSessionResume())

    await waitFor(() => {
      expect(state.resumeLiveSession).toHaveBeenCalledWith('in-project', 'agent-1', '/repo')
    })
    expect(state.resumeLiveSession).toHaveBeenCalledTimes(1)
    expect(state.resumeLiveSession).not.toHaveBeenCalledWith(
      'other-project',
      expect.anything(),
      expect.anything()
    )
  })

  it('desktop transport (no cursor accessor) skips the seed but still resumes', async () => {
    // Desktop has no WS cursor — `fetchSessionCursor` is absent on the
    // transport, so the optional chaining no-ops; resume proceeds (desktop
    // `session/load` replay covers the gap).
    const desktopTransport: Record<string, unknown> = {}
    vi.doMock('@/lib/acp-transport', () => ({ getAcpTransport: () => desktopTransport }))
    // Re-import with the desktop transport in place.
    vi.resetModules()
    state.sessionIndex = [eligibleSession()]
    state.resumeLiveSession.mockResolvedValue(undefined)

    const { useAcpSessionResume: desktopHook } = await import('./use-acp-session-resume')
    renderHook(() => desktopHook())

    await waitFor(() => {
      expect(state.resumeLiveSession).toHaveBeenCalledWith('s1', 'agent-1', '/repo')
    })
    expect(events.find((e) => e.name === 'acp-resume-succeeded')?.terminalId).toBe('s1')
  })

  it('does nothing without an active project or an empty index', async () => {
    state.sessionIndex = []
    renderHook(() => useAcpSessionResume())
    await Promise.resolve()
    expect(state.resumeLiveSession).not.toHaveBeenCalled()
    expect(events).toHaveLength(0)
  })
})
