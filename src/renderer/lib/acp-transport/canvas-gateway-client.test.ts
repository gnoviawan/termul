import type { WsCanvasCallFrame } from '@shared/types/web-protocol.types'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

import { CanvasGatewayClient } from './canvas-gateway-client'

function harness(live = true) {
  const sent: Array<[string, unknown]> = []
  const state = { live }
  const client = new CanvasGatewayClient({
    request: (type, payload) => {
      sent.push([type, payload])
      return Promise.resolve({})
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
    expect(handler).toHaveBeenCalledWith(CALL)
    expect(sent).toEqual([
      ['canvas_reply', { callId: 12, mountSeq: 3, ok: true, result: '{"id":18446744073709551615}' }]
    ])
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
})
