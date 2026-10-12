import type { WsWatchFrame } from '@shared/types/web-protocol.types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatchClient, type WatchTransport } from './watch-client'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

interface Sent {
  type: 'watch' | 'unwatch'
  watch: string
  scope: string
}

function makeTransport(): {
  transport: WatchTransport
  sent: Sent[]
  setLive: (live: boolean) => void
  failNext: (error: unknown) => void
} {
  const sent: Sent[] = []
  let live = true
  let failure: unknown = null
  return {
    sent,
    setLive: (value) => {
      live = value
    },
    failNext: (error) => {
      failure = error
    },
    transport: {
      isLive: () => live,
      request: (type, payload) => {
        sent.push({ type, watch: payload.watch, scope: payload.scope })
        if (failure) {
          const error = failure
          failure = null
          return Promise.reject(error)
        }
        return Promise.resolve({})
      }
    }
  }
}

const EPOCH = 'epoch-aaaaaaaa'

function stateFrame(n: number, state: unknown, epoch = EPOCH): WsWatchFrame {
  return {
    type: 'watch',
    watch: 'projects',
    scope: '',
    revision: { hostEpoch: epoch, n },
    reset: true,
    state
  }
}

function deltaFrame(n: number, delta: unknown, epoch = EPOCH): WsWatchFrame {
  return { type: 'watch', watch: 'projects', scope: '', revision: { hostEpoch: epoch, n }, delta }
}

const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(0)

describe('WatchClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes on a live socket and applies the state, then contiguous deltas', () => {
    const { transport, sent } = makeTransport()
    const client = new WatchClient(transport)
    const onState = vi.fn()
    const onDelta = vi.fn()
    client.subscribe('projects', { onState, onDelta })
    expect(sent).toEqual([{ type: 'watch', watch: 'projects', scope: '' }])

    client.handleFrame(stateFrame(1, { projects: [] }))
    client.handleFrame(deltaFrame(2, 'a'))
    client.handleFrame(deltaFrame(3, 'b'))

    expect(onState).toHaveBeenCalledWith({ projects: [] })
    expect(onDelta.mock.calls.map((call) => call[0])).toEqual(['a', 'b'])
    expect(sent).toHaveLength(1)
  })

  it('waits for the socket and subscribes when it connects', () => {
    const { transport, sent, setLive } = makeTransport()
    setLive(false)
    const client = new WatchClient(transport)
    client.subscribe('agents', { onState: vi.fn() })
    expect(sent).toHaveLength(0)

    setLive(true)
    client.onConnected()
    expect(sent).toEqual([{ type: 'watch', watch: 'agents', scope: '' }])
  })

  it('resubscribes when a revision is skipped and does not apply the delta after the hole', async () => {
    const { transport, sent } = makeTransport()
    const client = new WatchClient(transport)
    const onDelta = vi.fn()
    client.subscribe('projects', { onState: vi.fn(), onDelta })
    await flush()
    client.handleFrame(stateFrame(1, 'first'))
    client.handleFrame(deltaFrame(2, 'a'))

    client.handleFrame(deltaFrame(4, 'skipped-3'))

    expect(onDelta).toHaveBeenCalledTimes(1)
    await flush()
    expect(sent).toHaveLength(2)
    // Until the fresh state arrives, later deltas are not applied either.
    client.handleFrame(deltaFrame(5, 'late'))
    expect(onDelta).toHaveBeenCalledTimes(1)
    client.handleFrame(stateFrame(1, 'fresh'))
    client.handleFrame(deltaFrame(2, 'after'))
    expect(onDelta).toHaveBeenCalledTimes(2)
  })

  it('resubscribes when the host epoch changes', async () => {
    const { transport, sent } = makeTransport()
    const client = new WatchClient(transport)
    const onDelta = vi.fn()
    client.subscribe('projects', { onState: vi.fn(), onDelta })
    await flush()
    client.handleFrame(stateFrame(1, 'first'))

    client.handleFrame(deltaFrame(2, 'x', 'epoch-bbbbbbbb'))
    await flush()

    expect(onDelta).not.toHaveBeenCalled()
    expect(sent).toHaveLength(2)
  })

  it('ignores a duplicate delta and resubscribes on a resync marker', async () => {
    const { transport, sent } = makeTransport()
    const client = new WatchClient(transport)
    const onDelta = vi.fn()
    client.subscribe('projects', { onState: vi.fn(), onDelta })
    await flush()
    client.handleFrame(stateFrame(1, 'first'))
    client.handleFrame(deltaFrame(2, 'a'))

    client.handleFrame(deltaFrame(2, 'a-again'))
    expect(onDelta).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)

    client.handleFrame(deltaFrame(3, { resync: true }))
    await flush()
    expect(onDelta).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(2)
  })

  it('rebuilds every watch from fresh state after a reconnect', async () => {
    const { transport, sent } = makeTransport()
    const client = new WatchClient(transport)
    const onState = vi.fn()
    client.subscribe('projects', { onState })
    client.subscribe('chat_history', { onState: vi.fn() })
    await flush()
    client.handleFrame(stateFrame(1, 'first'))
    sent.length = 0

    client.onDisconnected()
    client.onConnected()
    await flush()

    expect(sent.map((s) => s.watch).sort()).toEqual(['chat_history', 'projects'])
    client.handleFrame(stateFrame(1, 'after-reconnect'))
    expect(onState).toHaveBeenLastCalledWith('after-reconnect')
  })

  it('retries a failed subscribe with backoff while the socket is live', async () => {
    const { transport, sent, failNext } = makeTransport()
    failNext(Object.assign(new Error('busy'), { code: 'rate_limited' }))
    const client = new WatchClient(transport)
    client.subscribe('projects', { onState: vi.fn() })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveLength(2)
  })

  it('does not retry a refusal the host will repeat', async () => {
    const { transport, sent, failNext } = makeTransport()
    failNext(Object.assign(new Error('no such watch'), { code: 'unsupported' }))
    const client = new WatchClient(transport)
    client.subscribe('projects', { onState: vi.fn() })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toHaveLength(1)
  })

  it('shares one subscription between handlers and refreshes state for all when one joins', async () => {
    const { transport, sent } = makeTransport()
    const client = new WatchClient(transport)
    const first = vi.fn()
    const second = vi.fn()
    client.subscribe('projects', { onState: first })
    client.subscribe('projects', { onState: second })
    await flush()

    client.handleFrame(stateFrame(1, 'shared'))

    expect(first).toHaveBeenCalledWith('shared')
    expect(second).toHaveBeenCalledWith('shared')
    expect(sent.every((s) => s.type === 'watch')).toBe(true)
  })

  it('unwatches on the last unsubscribe and ignores frames afterwards', async () => {
    const { transport, sent } = makeTransport()
    const client = new WatchClient(transport)
    const onState = vi.fn()
    const unsubscribe = client.subscribe('projects', { onState })
    await flush()
    unsubscribe()
    expect(sent.at(-1)).toEqual({ type: 'unwatch', watch: 'projects', scope: '' })

    client.handleFrame(stateFrame(1, 'late'))
    expect(onState).not.toHaveBeenCalled()
  })

  it('does not ask again for a watch that was released while its request was in flight', async () => {
    const { transport, sent } = makeTransport()
    const client = new WatchClient(transport)
    const unsubscribe = client.subscribe('projects', { onState: vi.fn() })
    // A second trigger queues one more request, then the last handler leaves.
    client.onConnected()
    unsubscribe()
    await flush()

    expect(sent.filter((s) => s.type === 'watch')).toHaveLength(1)
    expect(sent.at(-1)).toEqual({ type: 'unwatch', watch: 'projects', scope: '' })
  })

  it('keeps delivering to the other handlers when one throws, and asks for fresh state again', async () => {
    const { transport, sent } = makeTransport()
    const client = new WatchClient(transport)
    const survivor = vi.fn()
    client.subscribe('projects', {
      onState: () => {
        throw new Error('boom')
      }
    })
    client.subscribe('projects', { onState: survivor })
    await flush()
    const requests = sent.filter((s) => s.type === 'watch').length

    client.handleFrame(stateFrame(1, 'x'))
    expect(survivor).toHaveBeenCalledWith('x')

    // The failing handler holds no state for this revision: resubscribe after a backoff.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent.filter((s) => s.type === 'watch').length).toBe(requests + 1)
  })

  it('does not apply deltas to a watch whose handler failed until fresh state arrives', async () => {
    const { transport } = makeTransport()
    const client = new WatchClient(transport)
    const onDelta = vi.fn()
    let failState = true
    client.subscribe('projects', {
      onState: () => {
        if (failState) throw new Error('boom')
      },
      onDelta
    })
    await flush()
    client.handleFrame(stateFrame(1, 'x'))
    client.handleFrame(deltaFrame(2, 'a'))
    expect(onDelta).not.toHaveBeenCalled()

    failState = false
    client.handleFrame(stateFrame(1, 'fresh'))
    client.handleFrame(deltaFrame(2, 'b'))
    expect(onDelta).toHaveBeenCalledWith('b')
  })
})
