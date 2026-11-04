import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import type { AcpTransport } from '@/lib/acp-transport'
import { markChatRead } from './chat-read-sync'

function surface(
  markChatReadImpl = vi.fn(async (sessionId: string, seq: number, logEpoch: string | null) => ({
    sessionId,
    seq,
    logEpoch: logEpoch ?? undefined
  }))
) {
  return { markChatRead: markChatReadImpl } as unknown as AcpTransport
}

describe('markChatRead', () => {
  it('sends the read point to the host', async () => {
    const reply = vi.fn(async (sessionId: string) => ({ sessionId, seq: 11, logEpoch: 'e1' }))

    markChatRead('s1', { logEpoch: 'e1', seq: 7 }, surface(reply))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reply).toHaveBeenCalledWith('s1', 7, 'e1')
  })

  it('sends a seq once while it is in flight and again after a failure', async () => {
    const failing = vi.fn(async () => {
      throw new Error('host gone')
    })
    const phone = surface(failing)

    markChatRead('s2', { logEpoch: 'e1', seq: 7 }, phone)
    markChatRead('s2', { logEpoch: 'e1', seq: 7 }, phone)
    markChatRead('s2', { logEpoch: 'e1', seq: 5 }, phone)
    expect(failing).toHaveBeenCalledTimes(1)
    await new Promise((resolve) => setTimeout(resolve, 0))

    markChatRead('s2', { logEpoch: 'e1', seq: 7 }, phone)
    expect(failing).toHaveBeenCalledTimes(2)
    expect(failing).toHaveBeenLastCalledWith('s2', 7, 'e1')
  })

  it('does not send an answered point again, so a refused read is not resent on every update', async () => {
    const reply = vi.fn(async (sessionId: string) => ({ sessionId, seq: 0, logEpoch: 'e0' }))
    const phone = surface(reply)

    markChatRead('s3', { logEpoch: 'e1', seq: 7 }, phone)
    await new Promise((resolve) => setTimeout(resolve, 0))
    markChatRead('s3', { logEpoch: 'e1', seq: 7 }, phone)
    markChatRead('s3', { logEpoch: 'e2', seq: 7 }, phone)

    expect(reply.mock.calls).toEqual([
      ['s3', 7, 'e1'],
      ['s3', 7, 'e2']
    ])
  })
})
