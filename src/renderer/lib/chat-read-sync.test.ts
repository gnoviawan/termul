import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import type { AcpTransport } from '@/lib/acp-transport'
import { logFrontendError } from '@/lib/log-api'
import { useChatActivityStore } from '@/stores/chat-activity-store'
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

function failingThen(...outcomes: Array<'fail' | 'ok'>) {
  const impl = vi.fn(async (sessionId: string, seq: number, logEpoch: string | null) => {
    if (outcomes.shift() === 'ok') return { sessionId, seq, logEpoch: logEpoch ?? undefined }
    throw new Error('host gone')
  })
  return impl
}

function showUnread(sessionId: string, seq: number): void {
  useChatActivityStore.getState().apply({
    sessionId,
    busy: false,
    needsYou: false,
    unread: true,
    turnEnd: { seq, logEpoch: 'e1' }
  })
}

describe('markChatRead', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(logFrontendError).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    useChatActivityStore.getState().replace({})
  })

  it('sends the read point to the host', async () => {
    const reply = vi.fn(async (sessionId: string) => ({ sessionId, seq: 11, logEpoch: 'e1' }))

    markChatRead('s1', { logEpoch: 'e1', seq: 7 }, surface(reply))
    await vi.runAllTimersAsync()

    expect(reply).toHaveBeenCalledWith('s1', 7, 'e1')
  })

  it('sends a seq once while it is in flight and again once its retries ran out', async () => {
    showUnread('s2', 7)
    const failing = failingThen()
    const phone = surface(failing)

    markChatRead('s2', { logEpoch: 'e1', seq: 7 }, phone)
    markChatRead('s2', { logEpoch: 'e1', seq: 7 }, phone)
    markChatRead('s2', { logEpoch: 'e1', seq: 5 }, phone)
    expect(failing).toHaveBeenCalledTimes(1)
    await vi.runAllTimersAsync()
    expect(failing).toHaveBeenCalledTimes(4)
    expect(logFrontendError).toHaveBeenCalledTimes(4)

    markChatRead('s2', { logEpoch: 'e1', seq: 7 }, phone)
    expect(failing).toHaveBeenCalledTimes(5)
    expect(failing).toHaveBeenLastCalledWith('s2', 7, 'e1')
  })

  it('sends a failed point again after a delay, with no new call', async () => {
    showUnread('s4', 7)
    const flaky = failingThen('fail', 'ok')

    markChatRead('s4', { logEpoch: 'e1', seq: 7 }, surface(flaky))
    await vi.advanceTimersByTimeAsync(0)
    expect(flaky).toHaveBeenCalledTimes(1)
    expect(logFrontendError).toHaveBeenCalledWith({
      level: 'warn',
      source: 'chat-read-sync',
      message: 'mark_chat_read failed for a chat at seq 7: host gone'
    })

    await vi.runAllTimersAsync()
    expect(flaky.mock.calls).toEqual([
      ['s4', 7, 'e1'],
      ['s4', 7, 'e1']
    ])
  })

  it('drops the retry once a newer point was sent', async () => {
    showUnread('s5', 9)
    const flaky = failingThen('fail', 'ok')
    const phone = surface(flaky)

    markChatRead('s5', { logEpoch: 'e1', seq: 7 }, phone)
    await vi.advanceTimersByTimeAsync(0)
    markChatRead('s5', { logEpoch: 'e1', seq: 9 }, phone)
    await vi.runAllTimersAsync()

    expect(flaky.mock.calls).toEqual([
      ['s5', 7, 'e1'],
      ['s5', 9, 'e1']
    ])
  })

  it('drops the retry once the host no longer shows the chat unread', async () => {
    showUnread('s6', 7)
    const flaky = failingThen('fail', 'ok')

    markChatRead('s6', { logEpoch: 'e1', seq: 7 }, surface(flaky))
    await vi.advanceTimersByTimeAsync(0)
    useChatActivityStore.getState().apply({
      sessionId: 's6',
      busy: false,
      needsYou: false,
      unread: false,
      turnEnd: null
    })
    await vi.runAllTimersAsync()

    expect(flaky).toHaveBeenCalledTimes(1)
  })

  it('does not send an answered point again, so a refused read is not resent on every update', async () => {
    const reply = vi.fn(async (sessionId: string) => ({ sessionId, seq: 0, logEpoch: 'e0' }))
    const phone = surface(reply)

    markChatRead('s3', { logEpoch: 'e1', seq: 7 }, phone)
    await vi.runAllTimersAsync()
    markChatRead('s3', { logEpoch: 'e1', seq: 7 }, phone)
    markChatRead('s3', { logEpoch: 'e2', seq: 7 }, phone)

    expect(reply.mock.calls).toEqual([
      ['s3', 7, 'e1'],
      ['s3', 7, 'e2']
    ])
  })
})
