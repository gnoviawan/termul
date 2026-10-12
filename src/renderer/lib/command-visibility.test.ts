import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitUntilVisible } from './command-visibility'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

describe('waitUntilVisible (visible_at gate)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is visible at once without a visible_at or without a cursor to compare', async () => {
    expect(await waitUntilVisible(() => 1, undefined)).toBe(true)
    // Desktop: no cursor accessor, nothing to compare against.
    expect(await waitUntilVisible(undefined, 50)).toBe(true)
  })

  it('a null cursor (subscribed, no event yet) is not visible: it waits, then proceeds after the bound', async () => {
    let cursor: number | null = null
    let settled = false
    const waiting = waitUntilVisible(() => cursor, 5, { pollMs: 10, maxWaitMs: 1_000 }).then(
      (v) => {
        settled = true
        return v
      }
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(settled).toBe(false)
    cursor = 5
    await vi.advanceTimersByTimeAsync(10)
    expect(await waiting).toBe(true)

    const never = waitUntilVisible(() => null, 5, { pollMs: 10, maxWaitMs: 100 })
    await vi.advanceTimersByTimeAsync(150)
    expect(await never).toBe(false)
  })

  it('waits until the session cursor reaches visible_at', async () => {
    let cursor = 3
    let settled = false
    const waiting = waitUntilVisible(() => cursor, 5, { pollMs: 10, maxWaitMs: 1_000 }).then(
      (v) => {
        settled = true
        return v
      }
    )
    await vi.advanceTimersByTimeAsync(30)
    expect(settled).toBe(false)
    cursor = 5
    await vi.advanceTimersByTimeAsync(10)
    expect(await waiting).toBe(true)
  })

  it('gives up after the bounded wait instead of hanging the caller', async () => {
    const waiting = waitUntilVisible(() => 1, 9, { pollMs: 10, maxWaitMs: 100 })
    await vi.advanceTimersByTimeAsync(150)
    expect(await waiting).toBe(false)
  })
})
