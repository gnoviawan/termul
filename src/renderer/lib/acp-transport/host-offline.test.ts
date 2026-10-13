import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_OFFLINE_PROBE_INTERVAL_MS, HostOfflineMonitor, probeHostHealth } from './host-offline'

function stubHealth(answers: Array<boolean | 'throw'>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift() : answers[0]
    if (next === 'throw') throw new TypeError('network down')
    return { ok: next === true } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('probeHostHealth', () => {
  it('is true for a 2xx answer and false for an error status or a network failure', async () => {
    stubHealth([true])
    expect(await probeHostHealth()).toBe(true)
    stubHealth([false])
    expect(await probeHostHealth()).toBe(false)
    stubHealth(['throw'])
    expect(await probeHostHealth()).toBe(false)
  })
})

describe('HostOfflineMonitor', () => {
  it('probes at a slow cadence and calls onOnline once when the host answers', async () => {
    const fetchMock = stubHealth([false, false, true])
    const onOnline = vi.fn()
    const monitor = new HostOfflineMonitor(onOnline)
    monitor.start()

    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(HOST_OFFLINE_PROBE_INTERVAL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onOnline).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(HOST_OFFLINE_PROBE_INTERVAL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(HOST_OFFLINE_PROBE_INTERVAL_MS)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(onOnline).toHaveBeenCalledTimes(1)
    expect(monitor.active).toBe(false)

    await vi.advanceTimersByTimeAsync(HOST_OFFLINE_PROBE_INTERVAL_MS * 3)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('probeNow asks at once and skips the pending timer', async () => {
    const fetchMock = stubHealth([true])
    const onOnline = vi.fn()
    const monitor = new HostOfflineMonitor(onOnline)
    monitor.start()
    monitor.probeNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onOnline).toHaveBeenCalledTimes(1)
  })

  it('ignores an answer that arrives after stop', async () => {
    let resolveFetch: (value: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve)))
    )
    const onOnline = vi.fn()
    const monitor = new HostOfflineMonitor(onOnline)
    monitor.start()
    monitor.probeNow()
    monitor.stop()
    resolveFetch({ ok: true } as Response)
    await vi.advanceTimersByTimeAsync(0)
    expect(onOnline).not.toHaveBeenCalled()
  })

  it('does nothing on probeNow before start', async () => {
    const fetchMock = stubHealth([true])
    const monitor = new HostOfflineMonitor(vi.fn())
    monitor.probeNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
