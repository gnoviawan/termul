import type { WsCanvasCallFrame } from '@shared/types/web-protocol.types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { CanvasGatewayClient, REPLY_SLICE_UNITS } from './canvas-gateway-client'

function harness(live = true, answer: (payload: unknown) => unknown = () => ({})) {
  const sent: Array<[string, unknown]> = []
  const state = { live }
  const client = new CanvasGatewayClient({
    request: (type, payload) => {
      sent.push([type, payload])
      return Promise.resolve(answer(payload))
    },
    isLive: () => state.live
  })
  return { client, sent, state }
}

const CALL: WsCanvasCallFrame = {
  type: 'canvas_call',
  callId: 12,
  projectId: 'proj-1',
  mountSeq: 3,
  method: 'node.get',
  params: '{"id":18446744073709551615}'
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('CanvasGatewayClient', () => {
  it('reports a mount once, a new mountSeq again, and an unmount with the held seq', () => {
    const { client, sent } = harness()
    client.setMount('proj-1', 1)
    client.setMount('proj-1', 1)
    client.setMount('proj-1', 2)
    client.setMount('proj-1', null)
    client.setMount('proj-1', null)
    expect(sent).toEqual([
      ['canvas_mount', { projectId: 'proj-1', mountSeq: 1 }],
      ['canvas_mount', { projectId: 'proj-1', mountSeq: 2 }],
      ['canvas_unmount', { projectId: 'proj-1', mountSeq: 2 }]
    ])
  })

  it('re-reports every held mount on a new connection', () => {
    const { client, sent, state } = harness(false)
    client.setMount('proj-1', 4)
    client.setMount('proj-2', 1)
    expect(sent).toEqual([])
    state.live = true
    client.onConnected()
    expect(sent).toEqual([
      ['canvas_mount', { projectId: 'proj-1', mountSeq: 4 }],
      ['canvas_mount', { projectId: 'proj-2', mountSeq: 1 }]
    ])
  })

  it('answers a forwarded call through the handler with canvas_reply', async () => {
    const { client, sent } = harness()
    const handler = vi.fn(async (call: WsCanvasCallFrame) => ({
      callId: call.callId,
      mountSeq: call.mountSeq,
      ok: true as const,
      result: '{"id":18446744073709551615}'
    }))
    client.setCallHandler(handler)
    client.handleFrame(CALL)
    await settled()
    expect(handler).toHaveBeenCalledWith(CALL, undefined)
    expect(sent).toEqual([
      ['canvas_reply', { callId: 12, mountSeq: 3, ok: true, result: '{"id":18446744073709551615}' }]
    ])
  })

  it("turns the host's time left into a local deadline on arrival", async () => {
    vi.useFakeTimers({ now: 50_000, toFake: ['Date'] })
    try {
      const { client } = harness()
      const handler = vi.fn(async (call: WsCanvasCallFrame) => ({
        callId: call.callId,
        mountSeq: call.mountSeq,
        ok: true as const,
        result: '{}'
      }))
      client.setCallHandler(handler)
      client.handleFrame({ ...CALL, timeoutMs: 9_000 })
      expect(handler).toHaveBeenCalledWith({ ...CALL, timeoutMs: 9_000 }, 59_000)
    } finally {
      vi.useRealTimers()
    }
  })

  describe('a reply longer than one message', () => {
    type Sent = { result: string; partial?: true }

    function answeringWith(result: string, accept: (index: number) => boolean = () => true) {
      let index = 0
      const { client, sent } = harness(true, (payload) =>
        (payload as Sent).partial ? { accepted: accept(index++) } : { resolved: true }
      )
      client.setCallHandler(async (call) => ({
        callId: call.callId,
        mountSeq: call.mountSeq,
        ok: true as const,
        result
      }))
      client.handleFrame(CALL)
      return sent
    }

    const slices = (sent: Array<[string, unknown]>) => sent.map(([, payload]) => payload as Sent)

    it('is sent as slices, partial but the last, that join into the result', async () => {
      const result = 'a'.repeat(REPLY_SLICE_UNITS * 2 + 5)
      const sent = answeringWith(result)
      await vi.waitFor(() => expect(sent).toHaveLength(3))

      expect(sent.every(([type]) => type === 'canvas_reply')).toBe(true)
      expect(slices(sent).map((slice) => slice.partial)).toEqual([true, true, undefined])
      expect(
        slices(sent)
          .map((slice) => slice.result)
          .join('')
      ).toBe(result)
      expect(sent[2][1]).toEqual({ callId: 12, mountSeq: 3, ok: true, result: 'aaaaa' })
    })

    it('never splits a surrogate pair between slices', async () => {
      const result = `${'a'.repeat(REPLY_SLICE_UNITS - 1)}😀tail`
      const sent = answeringWith(result)
      await vi.waitFor(() => expect(sent).toHaveLength(2))

      const [first, last] = slices(sent)
      expect(first.result).toBe('a'.repeat(REPLY_SLICE_UNITS - 1))
      expect(last.result).toBe('😀tail')
      expect(first.result + last.result).toBe(result)
    })

    it('stops sending when the host no longer takes slices', async () => {
      const sent = answeringWith('a'.repeat(REPLY_SLICE_UNITS * 3), (index) => index < 1)
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      await settled()

      expect(slices(sent).map((slice) => slice.partial)).toEqual([true, true])
    })

    it('is one message at the slice size', async () => {
      const result = 'a'.repeat(REPLY_SLICE_UNITS)
      const sent = answeringWith(result)
      await settled()

      expect(sent).toEqual([['canvas_reply', { callId: 12, mountSeq: 3, ok: true, result }]])
    })
  })

  it('answers CANVAS_CLOSED when no handler is attached and ENGINE_ERROR when it throws', async () => {
    const { client, sent } = harness()
    client.handleFrame(CALL)
    client.setCallHandler(() => Promise.reject(new Error('boom')))
    client.handleFrame({ ...CALL, callId: 13 })
    await settled()
    expect(sent).toEqual([
      [
        'canvas_reply',
        {
          callId: 12,
          mountSeq: 3,
          ok: false,
          error: expect.objectContaining({ code: 'CANVAS_CLOSED' })
        }
      ],
      [
        'canvas_reply',
        {
          callId: 13,
          mountSeq: 3,
          ok: false,
          error: expect.objectContaining({ code: 'ENGINE_ERROR' })
        }
      ]
    ])
  })

  it('hands a lease-lost frame for the held mount to the handler and forgets the mount', () => {
    const { client, sent } = harness()
    const lost = vi.fn()
    client.setLeaseLostHandler(lost)
    client.setMount('proj-1', 3)
    client.handleLeaseLost({
      type: 'canvas_lease_lost',
      projectId: 'proj-1',
      mountSeq: 2,
      reason: 'takenOver'
    })
    expect(lost).not.toHaveBeenCalled()
    client.handleLeaseLost({
      type: 'canvas_lease_lost',
      projectId: 'proj-1',
      mountSeq: 3,
      reason: 'takenOver'
    })
    expect(lost).toHaveBeenCalledWith('proj-1', 3, 'elsewhere')
    client.setMount('proj-1', null)
    expect(sent).toEqual([['canvas_mount', { projectId: 'proj-1', mountSeq: 3 }]])
  })

  it('an eviction notice reaches the handler as evicted', () => {
    const { client } = harness()
    const lost = vi.fn()
    client.setLeaseLostHandler(lost)
    client.setMount('proj-1', 3)
    client.handleLeaseLost({
      type: 'canvas_lease_lost',
      projectId: 'proj-1',
      mountSeq: 3,
      reason: 'evicted'
    })
    expect(lost).toHaveBeenCalledWith('proj-1', 3, 'evicted')
  })

  it('treats a refused re-report as a lost lease: elsewhere when another window holds it, else expired', async () => {
    const sent: Array<[string, unknown]> = []
    const client = new CanvasGatewayClient({
      request: (type, payload) => {
        sent.push([type, payload])
        const { projectId } = payload as { projectId: string }
        return Promise.resolve(
          type === 'canvas_mount' ? { attached: false, heldElsewhere: projectId === 'proj-2' } : {}
        )
      },
      isLive: () => true
    })
    const lost = vi.fn()
    client.setLeaseLostHandler(lost)
    client.setMount('proj-1', 5)
    client.setMount('proj-2', 7)
    await settled()
    expect(lost).toHaveBeenCalledWith('proj-1', 5, 'expired')
    expect(lost).toHaveBeenCalledWith('proj-2', 7, 'elsewhere')
    client.onConnected()
    expect(sent).toEqual([
      ['canvas_mount', { projectId: 'proj-1', mountSeq: 5 }],
      ['canvas_mount', { projectId: 'proj-2', mountSeq: 7 }]
    ])
  })
})
