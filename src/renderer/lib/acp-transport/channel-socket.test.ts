import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

/** Fake Tauri IPC: `Channel` instances are captured so a test can push host frames. */
const ipc = vi.hoisted(() => ({
  channels: [] as Array<{ onmessage: (raw: unknown) => void }>,
  invoke: vi.fn()
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: ipc.invoke,
  Channel: class {
    onmessage: (raw: unknown) => void = () => {}
    constructor() {
      ipc.channels.push(this)
    }
  }
}))

import { ChannelSocket } from './channel-socket'

type Deferred = PromiseWithResolvers<unknown>

const deferred = (): Deferred => Promise.withResolvers<unknown>()

const calls = (command: string) =>
  ipc.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args)

/** `ws_channel_open` resolves with connection id 7; every other command acks. */
function ackEverything(): void {
  ipc.invoke.mockImplementation(async (command: string) =>
    command === 'ws_channel_open' ? 7 : undefined
  )
}

/** Every await in the carrier chains on already-settled mocks: draining microtasks settles them. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

async function openSocket(): Promise<{
  socket: ChannelSocket
  messages: string[]
  closes: Array<{ code: number; reason: string; wasClean: boolean }>
  errors: number
}> {
  const socket = new ChannelSocket('channel://desktop')
  const seen = {
    socket,
    messages: [] as string[],
    closes: [] as Array<{ code: number; reason: string; wasClean: boolean }>,
    errors: 0
  }
  socket.onmessage = (ev) => seen.messages.push(ev.data)
  socket.onclose = (ev) => seen.closes.push(ev)
  socket.onerror = () => {
    seen.errors += 1
  }
  await flush()
  return seen
}

beforeEach(() => {
  ipc.channels.length = 0
  ipc.invoke.mockReset()
})

describe('ChannelSocket', () => {
  it('opens one relay connection through ws_channel_open and fires onopen once ready', async () => {
    const open = deferred()
    ipc.invoke.mockImplementation((command: string) =>
      command === 'ws_channel_open' ? open.promise : Promise.resolve()
    )
    const socket = new ChannelSocket('channel://desktop')
    const onopen = vi.fn()
    socket.onopen = onopen

    expect(socket.readyState).toBe(ChannelSocket.CONNECTING)
    expect(ipc.invoke).toHaveBeenCalledWith('ws_channel_open', { onFrame: ipc.channels[0] })
    expect(onopen).not.toHaveBeenCalled()

    open.resolve(7)
    await flush()
    expect(socket.readyState).toBe(ChannelSocket.OPEN)
    expect(onopen).toHaveBeenCalledTimes(1)
  })

  it('holds frames that beat the open ack (the relay speaks first) and delivers them in order after onopen', async () => {
    const open = deferred()
    ipc.invoke.mockImplementation((command: string) =>
      command === 'ws_channel_open' ? open.promise : Promise.resolve()
    )
    const socket = new ChannelSocket('channel://desktop')
    const order: string[] = []
    socket.onopen = () => order.push('open')
    socket.onmessage = (ev) => order.push(ev.data)

    ipc.channels[0].onmessage('{"type":"auth_required"}')
    ipc.channels[0].onmessage('{"type":"heartbeat"}')
    expect(order).toEqual([])

    open.resolve(7)
    await flush()
    expect(order).toEqual(['open', '{"type":"auth_required"}', '{"type":"heartbeat"}'])
  })

  it('delivers replies, single events and events batches verbatim in channel order', async () => {
    ackEverything()
    const { messages } = await openSocket()
    const frames = [
      '{"id":"a","ok":true}',
      '{"sid":"s1","seq":1,"type":"user_prompt","payload":{}}',
      '{"type":"events","events":[{"sid":"s1","seq":2,"type":"message_chunk","payload":{}},{"sid":"s1","seq":3,"type":"prompt_complete","payload":{}}]}',
      '{"type":"gap","sid":"s1"}'
    ]
    for (const frame of frames) ipc.channels[0].onmessage(frame)
    expect(messages).toEqual(frames)
  })

  it('normalizes an already-parsed JSON body back to the text a socket would carry', async () => {
    ackEverything()
    const { messages } = await openSocket()
    ipc.channels[0].onmessage({ id: 'a', ok: true })
    expect(messages).toEqual(['{"id":"a","ok":true}'])
  })

  it('refuses send() while connecting, like a WebSocket', () => {
    ipc.invoke.mockImplementation(() => new Promise(() => {}))
    const socket = new ChannelSocket('channel://desktop')
    expect(() => socket.send('{}')).toThrow(/connecting/)
  })

  it('keeps ws_channel_send in call order even when the IPC acks complete out of order', async () => {
    const acks = [deferred(), deferred(), deferred()]
    let next = 0
    ipc.invoke.mockImplementation((command: string) => {
      if (command === 'ws_channel_open') return Promise.resolve(7)
      if (command === 'ws_channel_send') return acks[next++].promise
      return Promise.resolve()
    })
    const { socket } = await openSocket()

    socket.send('one')
    socket.send('two')
    socket.send('three')
    await flush()
    // Only the head of the queue is in flight; later frames wait for its ack.
    expect(calls('ws_channel_send')).toEqual([{ connectionId: 7, frame: 'one' }])

    acks[0].resolve()
    await flush()
    expect(calls('ws_channel_send').map((a) => (a as { frame: string }).frame)).toEqual([
      'one',
      'two'
    ])

    acks[1].resolve()
    acks[2].resolve()
    await flush()
    expect(calls('ws_channel_send').map((a) => (a as { frame: string }).frame)).toEqual([
      'one',
      'two',
      'three'
    ])
  })

  it('treats a failed ws_channel_send as a lost connection: onerror, onclose 1006, host released, later frames dropped', async () => {
    ipc.invoke.mockImplementation(async (command: string, args?: { frame?: string }) => {
      if (command === 'ws_channel_open') return 7
      if (command === 'ws_channel_send' && args?.frame === 'two') throw 'unknown connection'
      return undefined
    })
    const seen = await openSocket()

    seen.socket.send('one')
    seen.socket.send('two')
    seen.socket.send('three')
    await flush()

    expect(calls('ws_channel_send').map((a) => (a as { frame: string }).frame)).toEqual([
      'one',
      'two'
    ])
    expect(seen.errors).toBe(1)
    expect(seen.closes).toEqual([{ code: 1006, reason: 'channel send failed', wasClean: false }])
    expect(seen.socket.readyState).toBe(ChannelSocket.CLOSED)
    expect(calls('ws_channel_close')).toEqual([{ connectionId: 7 }])
  })

  it('consumes a channel_closed frame as onclose with the host code and drops everything after it', async () => {
    ackEverything()
    const seen = await openSocket()

    ipc.channels[0].onmessage('{"id":"a","ok":true}')
    // Rust serializes keys alphabetically: the frame is recognised by `type`, not by prefix.
    ipc.channels[0].onmessage('{"code":1001,"reason":"host stopping","type":"channel_closed"}')
    ipc.channels[0].onmessage('{"id":"late","ok":true}')

    expect(seen.messages).toEqual(['{"id":"a","ok":true}'])
    expect(seen.closes).toEqual([{ code: 1001, reason: 'host stopping', wasClean: true }])
    expect(seen.socket.readyState).toBe(ChannelSocket.CLOSED)
    // The host already ended the connection: nothing to release, and sends are discarded.
    seen.socket.send('after')
    await flush()
    expect(calls('ws_channel_close')).toEqual([])
    expect(calls('ws_channel_send')).toEqual([])
  })

  it('does not mistake chat text that mentions channel_closed for the terminal frame', async () => {
    ackEverything()
    const seen = await openSocket()
    const chatty =
      '{"sid":"s1","seq":1,"type":"message_chunk","payload":{"text":"the \\"channel_closed\\" frame"}}'
    ipc.channels[0].onmessage(chatty)
    expect(seen.messages).toEqual([chatty])
    expect(seen.closes).toEqual([])
    expect(seen.socket.readyState).toBe(ChannelSocket.OPEN)
  })

  it('delivers a channel_closed frame that arrived before the open ack after the earlier frames', async () => {
    const open = deferred()
    ipc.invoke.mockImplementation((command: string) =>
      command === 'ws_channel_open' ? open.promise : Promise.resolve()
    )
    const socket = new ChannelSocket('channel://desktop')
    const seen: string[] = []
    socket.onmessage = (ev) => seen.push(ev.data)
    socket.onclose = (ev) => seen.push(`close:${ev.code}`)

    ipc.channels[0].onmessage('{"type":"auth_required"}')
    ipc.channels[0].onmessage('{"code":1001,"reason":"","type":"channel_closed"}')
    open.resolve(7)
    await flush()

    expect(seen).toEqual(['{"type":"auth_required"}', 'close:1001'])
  })

  it('close() releases the host once and fires onclose once, however often it is called', async () => {
    ackEverything()
    const seen = await openSocket()

    seen.socket.close()
    seen.socket.close(1000, 'again')
    await flush()
    seen.socket.close()
    await flush()

    expect(calls('ws_channel_close')).toEqual([{ connectionId: 7 }])
    expect(seen.closes).toEqual([{ code: 1000, reason: '', wasClean: true }])
    seen.socket.send('late')
    await flush()
    expect(calls('ws_channel_send')).toEqual([])
  })

  it('close() lets already-queued frames reach the host first', async () => {
    ackEverything()
    const seen = await openSocket()
    seen.socket.send('queued')
    seen.socket.close()
    await flush()

    const order = ipc.invoke.mock.calls
      .map(([name]) => name)
      .filter((name) => name !== 'ws_channel_open')
    expect(order).toEqual(['ws_channel_send', 'ws_channel_close'])
  })

  it('a close() issued while connecting closes the host connection as soon as it is known', async () => {
    const open = deferred()
    ipc.invoke.mockImplementation((command: string) =>
      command === 'ws_channel_open' ? open.promise : Promise.resolve()
    )
    const socket = new ChannelSocket('channel://desktop')
    const onopen = vi.fn()
    const closes: number[] = []
    socket.onopen = onopen
    socket.onclose = (ev) => closes.push(ev.code)

    socket.close()
    open.resolve(9)
    await flush()

    expect(onopen).not.toHaveBeenCalled()
    expect(calls('ws_channel_close')).toEqual([{ connectionId: 9 }])
    expect(closes).toEqual([1000])
  })

  it('a rejected ws_channel_open surfaces as onerror + onclose 1006', async () => {
    ipc.invoke.mockRejectedValue('no window')
    const seen = await openSocket()
    expect(seen.errors).toBe(1)
    expect(seen.closes).toEqual([{ code: 1006, reason: 'channel open failed', wasClean: false }])
    expect(seen.socket.readyState).toBe(ChannelSocket.CLOSED)
  })
})
