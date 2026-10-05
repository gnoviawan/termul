import { describe, expect, it } from 'vitest'
import { AcpTransportError } from '@/lib/acp-transport'
import {
  _resetDroppedLaunchPlaceholdersForTesting,
  isIndexedRealSession,
  isLaunchPlaceholderSessionId,
  isReopenTurnActiveError,
  type LaunchRecoveryCandidate,
  noteDroppedLaunchPlaceholders,
  partitionRestoredAgentChatIds,
  persistedTurnIsLive,
  selectLaunchRecoverySessions,
  takeAllDroppedLaunchPlaceholders
} from './live-turn'

function entry(
  id: string,
  overrides: Partial<LaunchRecoveryCandidate> = {}
): LaunchRecoveryCandidate {
  return {
    id,
    projectId: 'p1',
    status: 'active',
    lastActivityAt: 1,
    ...overrides
  }
}

describe('live-turn reload gating', () => {
  it('treats only turnActive metadata as a live turn', () => {
    expect(persistedTurnIsLive({ turnActive: true })).toBe(true)
    expect(persistedTurnIsLive({ turnActive: false })).toBe(false)
    expect(persistedTurnIsLive({})).toBe(false)
    expect(persistedTurnIsLive(null)).toBe(false)
  })

  it('recognizes the single-owner guard on both transports', () => {
    expect(isReopenTurnActiveError('ACP_REOPEN_TURN_ACTIVE: session echo-1')).toBe(true)
    expect(
      isReopenTurnActiveError(
        new AcpTransportError('not_implemented', 'ACP_REOPEN_TURN_ACTIVE: session echo-1')
      )
    ).toBe(true)
    expect(isReopenTurnActiveError(new Error('session not found'))).toBe(false)
    expect(
      String(new AcpTransportError('not_implemented', 'ACP_REOPEN_TURN_ACTIVE: session echo-1'))
    ).toContain('ACP_REOPEN_TURN_ACTIVE')
  })

  it('does not treat a launch placeholder as an indexed real session', () => {
    expect(isLaunchPlaceholderSessionId('launch-abc')).toBe(true)
    expect(isLaunchPlaceholderSessionId('echo-1')).toBe(false)
    expect(isIndexedRealSession([{ id: 'echo-1' }, { id: 'launch-abc' }], 'echo-1')).toBe(true)
    expect(isIndexedRealSession([{ id: 'launch-abc' }], 'launch-abc')).toBe(false)
    expect(isIndexedRealSession([{ id: 'echo-1' }], 'echo-missing')).toBe(false)
  })

  it('partitions restored chat ids and remembers dropped placeholders per project', () => {
    _resetDroppedLaunchPlaceholdersForTesting()
    expect(partitionRestoredAgentChatIds(['launch-a', 'echo-1', 'launch-b', ''])).toEqual({
      placeholders: ['launch-a', 'launch-b'],
      sessionIds: ['echo-1']
    })
    noteDroppedLaunchPlaceholders('p1', ['launch-a', 'echo-1', 'launch-a'])
    noteDroppedLaunchPlaceholders('p2', ['launch-c'])
    expect(takeAllDroppedLaunchPlaceholders()).toEqual([
      { projectId: 'p1', count: 1 },
      { projectId: 'p2', count: 1 }
    ])
    expect(takeAllDroppedLaunchPlaceholders()).toEqual([])
  })

  it('prefers turn-active sessions and otherwise opens only a single active chat', () => {
    const open = new Set(['echo-open'])
    const entries = [
      entry('launch-x', { lastActivityAt: 99 }),
      entry('echo-open', { turnActive: true, lastActivityAt: 50 }),
      entry('echo-live', { turnActive: true, lastActivityAt: 10 }),
      entry('echo-newer-live', { turnActive: true, lastActivityAt: 20 }),
      entry('echo-idle', { lastActivityAt: 100 }),
      entry('echo-discovered', { discovered: true, turnActive: true, lastActivityAt: 80 }),
      entry('echo-other-project', { projectId: 'p2', turnActive: true, lastActivityAt: 70 })
    ]
    expect(selectLaunchRecoverySessions(entries, 'p1', open, 1).map((e) => e.id)).toEqual([
      'echo-newer-live'
    ])
    expect(selectLaunchRecoverySessions(entries, 'p1', open, 2).map((e) => e.id)).toEqual([
      'echo-newer-live',
      'echo-live'
    ])

    const idle = [
      entry('echo-a', { lastActivityAt: 2 }),
      entry('echo-b', { lastActivityAt: 3 }),
      entry('echo-closed', { status: 'closed', lastActivityAt: 9 })
    ]
    expect(selectLaunchRecoverySessions(idle, 'p1', new Set(), 1)).toEqual([])
    expect(
      selectLaunchRecoverySessions([entry('echo-only')], 'p1', new Set(), 1).map((e) => e.id)
    ).toEqual(['echo-only'])
    expect(selectLaunchRecoverySessions(idle, 'p1', new Set(), 0)).toEqual([])
  })
})
