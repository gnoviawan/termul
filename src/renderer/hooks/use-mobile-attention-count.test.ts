import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMobileAttentionCount } from './use-mobile-attention-count'

interface TestSession {
  projectId: string
  agentId: string
  status: string
}

const { signalsRef, storeRef, ephemeralRef } = vi.hoisted(() => ({
  signalsRef: { current: { attentionCounts: {} as Record<string, number> } },
  storeRef: {
    current: {} as {
      sessions: Record<string, TestSession>
      agentStatus: Record<string, string>
      pendingPermissions: Record<string, { sessionId: string }>
      pendingQuestions: Record<string, { sessionId: string }>
      pendingElicitations?: Record<string, { sessionId: string }>
    }
  },
  ephemeralRef: { current: new Set<string>() }
}))

vi.mock('./use-agent-chat-attention', () => ({
  useAgentChatProjectSignals: () => ({
    attentionCounts: signalsRef.current.attentionCounts,
    firstNeedsYouSessionId: {},
    runningProjectIds: new Set<string>()
  })
}))

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (state: unknown) => unknown) => selector(storeRef.current),
  isEphemeralAcpSession: (sessionId: string) => ephemeralRef.current.has(sessionId)
}))

function seed(options: {
  counts: Record<string, number>
  active?: Partial<TestSession>
  agentStatus?: string
  permission?: boolean
  question?: boolean
  elicitation?: boolean
}): void {
  signalsRef.current = { attentionCounts: options.counts }
  storeRef.current = {
    sessions: {
      active: {
        projectId: 'p1',
        agentId: 'a1',
        status: 'ready',
        ...options.active
      }
    },
    agentStatus: { a1: options.agentStatus ?? 'connected' },
    pendingPermissions: options.permission ? { r1: { sessionId: 'active' } } : {},
    pendingQuestions: options.question ? { q1: { sessionId: 'active' } } : {},
    pendingElicitations: options.elicitation ? { e1: { sessionId: 'active' } } : {}
  }
}

describe('useMobileAttentionCount', () => {
  beforeEach(() => {
    ephemeralRef.current = new Set()
    seed({ counts: {} })
  })

  it('subtracts the active chat when it needs attention (pending permission)', () => {
    seed({ counts: { p1: 3 }, permission: true })
    const { result } = renderHook(() => useMobileAttentionCount('p1', 'active'))
    expect(result.current).toBe(2)
  })

  it('subtracts the active chat for a pending question', () => {
    seed({ counts: { p1: 2 }, question: true })
    const { result } = renderHook(() => useMobileAttentionCount('p1', 'active'))
    expect(result.current).toBe(1)
  })

  it('subtracts the active chat for a pending elicitation', () => {
    seed({ counts: { p1: 2 }, elicitation: true })
    const { result } = renderHook(() => useMobileAttentionCount('p1', 'active'))
    expect(result.current).toBe(1)
  })

  it('tolerates a store without an elicitations map', () => {
    seed({ counts: { p1: 2 } })
    storeRef.current = { ...storeRef.current, pendingElicitations: undefined }
    const { result } = renderHook(() => useMobileAttentionCount('p1', 'active'))
    expect(result.current).toBe(2)
  })

  it('subtracts the active chat for a closed session or disconnected agent', () => {
    seed({ counts: { p1: 2 }, active: { status: 'closed' } })
    const closed = renderHook(() => useMobileAttentionCount('p1', 'active'))
    expect(closed.result.current).toBe(1)

    seed({ counts: { p1: 2 }, agentStatus: 'disconnected' })
    const disconnected = renderHook(() => useMobileAttentionCount('p1', 'active'))
    expect(disconnected.result.current).toBe(1)
  })

  it('keeps the count when the active chat does not need attention', () => {
    seed({ counts: { p1: 3 } })
    const { result } = renderHook(() => useMobileAttentionCount('p1', 'active'))
    expect(result.current).toBe(3)
  })

  it('does not subtract for an ephemeral warm-up session', () => {
    ephemeralRef.current = new Set(['active'])
    seed({ counts: { p1: 3 }, permission: true })
    const { result } = renderHook(() => useMobileAttentionCount('p1', 'active'))
    expect(result.current).toBe(3)
  })

  it('does not subtract when the active chat belongs to another project', () => {
    seed({ counts: { p1: 2 }, active: { projectId: 'p2' }, permission: true })
    const { result } = renderHook(() => useMobileAttentionCount('p1', 'active'))
    expect(result.current).toBe(2)
  })

  it('does not subtract without an active chat (terminal, editor or no tab)', () => {
    seed({ counts: { p1: 2 }, permission: true })
    const { result } = renderHook(() => useMobileAttentionCount('p1', null))
    expect(result.current).toBe(2)
  })

  it('does not subtract when the session is not loaded', () => {
    seed({ counts: { p1: 2 } })
    const { result } = renderHook(() => useMobileAttentionCount('p1', 'unknown'))
    expect(result.current).toBe(2)
  })

  it('reads only the active project and returns 0 when it has no count', () => {
    seed({ counts: { p2: 4 } })
    const { result } = renderHook(() => useMobileAttentionCount('p1', 'active'))
    expect(result.current).toBe(0)
  })

  it('clamps at 0 when the active chat is the only one counted or the counts lag', () => {
    seed({ counts: { p1: 1 }, permission: true })
    const only = renderHook(() => useMobileAttentionCount('p1', 'active'))
    expect(only.result.current).toBe(0)

    seed({ counts: {}, permission: true })
    const lagging = renderHook(() => useMobileAttentionCount('p1', 'active'))
    expect(lagging.result.current).toBe(0)
  })

  it('returns 0 with no active project', () => {
    seed({ counts: { p1: 2 } })
    const { result } = renderHook(() => useMobileAttentionCount(undefined, null))
    expect(result.current).toBe(0)
  })
})
