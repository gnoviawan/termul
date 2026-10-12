import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_CURSOR_RETRY_ATTEMPTS,
  SESSION_RETRY_MAX_ATTEMPTS,
  SessionResubscribeRetry,
  type SessionRetryMode
} from './ws-session-retry'

describe('SessionResubscribeRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function build(opts?: { canRun?: boolean }) {
    const runs: Array<[string, SessionRetryMode]> = []
    const giveUps: string[] = []
    let failing = true
    let canRun = opts?.canRun ?? true
    const retry = new SessionResubscribeRetry({
      run: async (sid, mode) => {
        runs.push([sid, mode])
        if (failing) throw new Error('subscribe failed')
      },
      onGiveUp: (sid) => giveUps.push(sid),
      canRun: () => canRun,
      random: () => 0.5 // neutral jitter: 1s, 2s, 4s, 8s, 16s, 30s
    })
    return {
      retry,
      runs,
      giveUps,
      heal: () => {
        failing = false
      },
      setCanRun: (value: boolean) => {
        canRun = value
      }
    }
  }

  it('retries from the cursor first, then degrades, then gives up after the bounded attempts', async () => {
    const { retry, runs, giveUps } = build()
    retry.schedule('s1', new Error('first failure'))

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.advanceTimersByTimeAsync(4_000)
    await vi.advanceTimersByTimeAsync(8_000)
    await vi.advanceTimersByTimeAsync(16_000)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(runs.map(([, mode]) => mode)).toEqual([
      ...Array(SESSION_CURSOR_RETRY_ATTEMPTS).fill('cursor'),
      ...Array(SESSION_RETRY_MAX_ATTEMPTS - SESSION_CURSOR_RETRY_ATTEMPTS).fill('degrade')
    ])
    expect(giveUps).toEqual(['s1'])
    expect(retry.has('s1')).toBe(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(runs).toHaveLength(SESSION_RETRY_MAX_ATTEMPTS) // nothing after giving up
  })

  it('stops retrying a session as soon as one attempt succeeds', async () => {
    const { retry, runs, giveUps, heal } = build()
    retry.schedule('s1')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runs).toHaveLength(1)
    heal()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(runs).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs).toHaveLength(2)
    expect(giveUps).toEqual([])
    expect(retry.has('s1')).toBe(false)
  })

  it('keeps independent backoff per session', async () => {
    const { retry, runs } = build()
    retry.schedule('a')
    await vi.advanceTimersByTimeAsync(1_000) // a: attempt 1 runs, next in 2s
    retry.schedule('b') // b starts its own ladder at 1s
    await vi.advanceTimersByTimeAsync(1_000) // t=2s: b's 1s retry ran; a waits for its 2s step
    expect(runs.filter(([sid]) => sid === 'b')).toHaveLength(1)
    expect(runs.filter(([sid]) => sid === 'a')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000) // t=3s: a's second attempt
    expect(runs.filter(([sid]) => sid === 'a')).toHaveLength(2)
  })

  it('drops a retry instead of running it while the socket is not usable', async () => {
    const { retry, runs, setCanRun } = build()
    retry.schedule('s1')
    setCanRun(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs).toHaveLength(0)
    expect(retry.has('s1')).toBe(false)
  })

  it('cancel and cancelAll clear pending retries', async () => {
    const { retry, runs } = build()
    retry.schedule('a')
    retry.schedule('b')
    retry.cancel('a')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(runs.map(([sid]) => sid)).toEqual(['b'])
    retry.cancelAll()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs).toHaveLength(1)
  })
})
