/**
 * Issue #1595: the host's pending-approval list a (re)subscribe carries is
 * installed into the store — a missing approval comes back (with the
 * history watermark unable to hide it), an answered one is dropped, and an
 * answer still on its way is not undone.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { respondPermissionMock } = vi.hoisted(() => ({ respondPermissionMock: vi.fn() }))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/acp-api', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/acp-api')>()
  return {
    ...actual,
    acpApi: { ...actual.acpApi, respondPermission: respondPermissionMock }
  }
})

import type { PermissionRequestEvent } from '@/lib/acp-api'
import { useAcpStore } from '@/stores/acp-store'
import { syncPendingPermissions } from './pending-permission-sync'
import { historySeqWatermarks } from './shared-state'
import { FRESH } from './testkit'

const SID = 'sess-1'

function request(requestId: string, sessionId = SID): PermissionRequestEvent {
  return {
    agentId: 'agent-1',
    sessionId,
    requestId,
    toolCall: { toolCallId: `tc-${requestId}`, title: 'Run tests' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
  }
}

const sync = (sessionId: string, requests: PermissionRequestEvent[]) =>
  syncPendingPermissions(useAcpStore.getState, useAcpStore.setState, sessionId, requests)

const pendingIds = () => Object.keys(useAcpStore.getState().pendingPermissions).sort()

describe('syncPendingPermissions', () => {
  beforeEach(() => {
    useAcpStore.setState(FRESH)
    historySeqWatermarks.clear()
    respondPermissionMock.mockReset()
  })

  it('restores an approval the reconnect lost, even below the history watermark', () => {
    // The installed payload covers seqs up to 40: a replayed request at seq 12
    // is dropped as history, and the snapshot never holds the request.
    historySeqWatermarks.set(SID, 40)
    useAcpStore.getState()._onPermissionRequest(request('perm-1'), 12)
    expect(pendingIds()).toEqual([])

    sync(SID, [request('perm-1')])
    const pending = useAcpStore.getState().pendingPermissions['perm-1']
    expect(pending).toMatchObject({ requestId: 'perm-1', sessionId: SID, agentId: 'agent-1' })
    expect(pending.options).toEqual(request('perm-1').options)
  })

  it('drops an approval of the session the host no longer holds and keeps other sessions', () => {
    useAcpStore.getState()._onPermissionRequest(request('perm-answered'))
    useAcpStore.getState()._onPermissionRequest(request('perm-other', 'sess-2'))

    sync(SID, [request('perm-1')])
    expect(pendingIds()).toEqual(['perm-1', 'perm-other'])

    sync(SID, [])
    expect(pendingIds()).toEqual(['perm-other'])
  })

  it('keeps an existing entry instead of replacing it', () => {
    useAcpStore.getState()._onPermissionRequest(request('perm-1'))
    const before = useAcpStore.getState().pendingPermissions['perm-1']
    sync(SID, [request('perm-1')])
    expect(useAcpStore.getState().pendingPermissions['perm-1']).toBe(before)
  })

  it('does not bring back an approval whose answer is still on its way', async () => {
    useAcpStore.getState()._onPermissionRequest(request('perm-1'))
    let finish: () => void = () => {}
    respondPermissionMock.mockImplementation(
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    const answering = useAcpStore.getState().respondPermission('perm-1', 'allow')
    // A list taken before the host processed the answer still names it.
    sync(SID, [request('perm-1')])
    expect(pendingIds()).toEqual([])
    finish()
    await answering
    expect(pendingIds()).toEqual([])
  })
})
