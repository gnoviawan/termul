/**
 * The canvas store's mounts drive the gateway's mount reports, and forwarded
 * calls run through the mounted bridge.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
const writeSnapshot = vi.hoisted(() => vi.fn())
vi.mock('@/lib/canvas-api', () => ({
  canvasApi: { open: vi.fn(), close: vi.fn(), writeSnapshot }
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import type { CanvasOpenInfo } from '@shared/types/canvas.types'
import type { AcpTransport } from '@/lib/acp-transport'
import { CanvasGatewayClient } from '@/lib/acp-transport/canvas-gateway-client'
import { asJsonText, type CanvasBridge, createCanvasBridge } from '@/lib/canvas-bridge'
import { type CanvasPhase, useCanvasStore } from '@/stores/canvas-store'
import { useProjectStore } from '@/stores/project-store'
import { startCanvasGateway } from '../canvas-gateway'

const INFO: CanvasOpenInfo = {
  canvasId: 'cv1',
  baseUrl: 'http://127.0.0.1:5199',
  canvasToken: 'token',
  pinTag: 'dev',
  docKey: 'C:/p/design.figcraft'
}

function setPhase(projectId: string, phase: CanvasPhase | null): void {
  useCanvasStore.setState((state) => {
    const { [projectId]: _dropped, ...rest } = state.sessions
    return {
      sessions:
        phase === null
          ? rest
          : {
              ...rest,
              [projectId]: {
                projectId,
                docPath: INFO.docKey,
                phase,
                dirty: false,
                contentVersion: null
              }
            }
    }
  })
}

function harness() {
  const sent: Array<[string, unknown]> = []
  const canvas = new CanvasGatewayClient({
    request: (type, payload) => {
      sent.push([type, payload])
      return Promise.resolve({})
    },
    isLive: () => true
  })
  const stop = startCanvasGateway({ canvas } as unknown as AcpTransport)
  return { canvas, sent, stop }
}

let stopGateway: (() => void) | null = null

afterEach(() => {
  stopGateway?.()
  stopGateway = null
  useCanvasStore.setState({ sessions: {} })
  useProjectStore.setState({ projects: [] })
  writeSnapshot.mockReset()
})

describe('startCanvasGateway', () => {
  it('reports loading and ready mounts, remounts, and closes', () => {
    const { sent, stop } = harness()
    stopGateway = stop
    setPhase('proj-1', { kind: 'opening' })
    setPhase('proj-1', { kind: 'loading', mount: { mountSeq: 1, info: INFO } })
    setPhase('proj-1', { kind: 'ready', mount: { mountSeq: 1, info: INFO } })
    setPhase('proj-1', { kind: 'loading', mount: { mountSeq: 2, info: INFO } })
    setPhase('proj-1', null)
    expect(sent).toEqual([
      ['canvas_mount', { projectId: 'proj-1', mountSeq: 1 }],
      ['canvas_mount', { projectId: 'proj-1', mountSeq: 2 }],
      ['canvas_unmount', { projectId: 'proj-1', mountSeq: 2 }]
    ])
  })

  it('runs a forwarded call through the mounted bridge and replies with its result text', async () => {
    const { canvas, sent, stop } = harness()
    stopGateway = stop
    setPhase('proj-1', { kind: 'ready', mount: { mountSeq: 5, info: INFO } })
    const bridge: CanvasBridge = {
      call: vi.fn(async () => ({
        ok: true as const,
        result: asJsonText('{"id":18446744073709551615}')
      })),
      dispose: vi.fn()
    }
    useCanvasStore.getState().attachBridge('proj-1', 5, bridge)

    canvas.handleFrame({
      type: 'canvas_call',
      callId: 8,
      projectId: 'proj-1',
      mountSeq: 5,
      method: 'node.get',
      params: '{"id":18446744073709551615}'
    })
    await vi.waitFor(() => expect(sent.at(-1)?.[0]).toBe('canvas_reply'))
    expect(bridge.call).toHaveBeenCalledWith('node.get', '{"id":18446744073709551615}', undefined)
    expect(sent.at(-1)).toEqual([
      'canvas_reply',
      { callId: 8, mountSeq: 5, ok: true, result: '{"id":18446744073709551615}' }
    ])
    useCanvasStore.getState().detachBridge('proj-1', bridge)
  })

  it('drops a call still queued for a loading editor once the host stopped waiting, and the queue on unmount', async () => {
    const { canvas, sent, stop } = harness()
    stopGateway = stop
    setPhase('proj-1', { kind: 'loading', mount: { mountSeq: 5, info: INFO } })
    const posted: Array<{ method: string }> = []
    const contentWindow = { postMessage: (data: { method: string }) => posted.push(data) }
    const bridge = createCanvasBridge({
      iframe: { contentWindow } as unknown as HTMLIFrameElement,
      canvasOrigin: INFO.baseUrl,
      mountSeq: 5,
      onEvent: () => {}
    })
    useCanvasStore.getState().attachBridge('proj-1', 5, bridge)
    const frame = (callId: number, method: string, timeoutMs: number) => ({
      type: 'canvas_call' as const,
      callId,
      projectId: 'proj-1',
      mountSeq: 5,
      method,
      params: '{}',
      timeoutMs
    })
    vi.useFakeTimers({ now: 10_000, toFake: ['Date'] })
    try {
      canvas.handleFrame(frame(1, 'engine.execute', 1_000))
      canvas.handleFrame(frame(2, 'document.inspect', 60_000))
      vi.setSystemTime(12_000)
      const ready = new MessageEvent('message', {
        data: { method: 'event.ready', params: '{}', mountSeq: 5 }
      })
      Object.defineProperty(ready, 'origin', { value: new URL(INFO.baseUrl).origin })
      Object.defineProperty(ready, 'source', { value: contentWindow })
      window.dispatchEvent(ready)
    } finally {
      vi.useRealTimers()
    }
    await vi.waitFor(() => expect(sent.filter(([type]) => type === 'canvas_reply')).toHaveLength(1))
    expect(posted.map((envelope) => envelope.method)).toEqual(['document.inspect'])
    expect(sent.find(([type]) => type === 'canvas_reply')?.[1]).toMatchObject({
      callId: 1,
      ok: false,
      error: { code: 'CANVAS_TIMEOUT' }
    })

    useCanvasStore.getState().detachBridge('proj-1', bridge)
    await vi.waitFor(() => expect(sent.filter(([type]) => type === 'canvas_reply')).toHaveLength(2))
    expect(sent.filter(([type]) => type === 'canvas_reply')[1]?.[1]).toMatchObject({
      callId: 2,
      ok: false,
      error: { code: 'CANVAS_CLOSED' }
    })
  })

  it('answers CANVAS_CLOSED for a project this renderer has not mounted', async () => {
    const { canvas, sent, stop } = harness()
    stopGateway = stop
    canvas.handleFrame({
      type: 'canvas_call',
      callId: 2,
      projectId: 'proj-9',
      mountSeq: 1,
      method: 'document.inspect',
      params: '{}'
    })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toEqual([
      'canvas_reply',
      expect.objectContaining({
        callId: 2,
        ok: false,
        error: expect.objectContaining({ code: 'CANVAS_CLOSED' })
      })
    ])
  })

  it('answers host.remounted by moving the store to the new mount, which it then reports', async () => {
    const { canvas, sent, stop } = harness()
    stopGateway = stop
    setPhase('proj-1', { kind: 'ready', mount: { mountSeq: 4, info: INFO } })
    sent.length = 0
    const remount = {
      previousMountSeq: 4,
      mountSeq: 6,
      reason: '3 consecutive calls timed out',
      lost: null
    }
    canvas.handleFrame({
      type: 'canvas_call',
      callId: 9,
      projectId: 'proj-1',
      mountSeq: 4,
      method: 'host.remounted',
      params: JSON.stringify(remount)
    })
    await vi.waitFor(() => expect(sent.some(([type]) => type === 'canvas_reply')).toBe(true))

    expect(useCanvasStore.getState().sessions['proj-1']?.phase).toEqual({
      kind: 'loading',
      mount: { mountSeq: 6, info: { ...INFO, mountSeq: 6 } }
    })
    expect(useCanvasStore.getState().sessions['proj-1']?.crash).toEqual(remount)
    expect(sent).toContainEqual(['canvas_mount', { projectId: 'proj-1', mountSeq: 6 }])
    expect(sent).toContainEqual([
      'canvas_reply',
      { callId: 9, mountSeq: 4, ok: true, result: '{}' }
    ])
  })

  function hostSaveCall(canvas: CanvasGatewayClient, callId: number, mountSeq: number): void {
    canvas.handleFrame({
      type: 'canvas_call',
      callId,
      projectId: 'proj-1',
      mountSeq,
      method: 'host.save',
      params: '{}'
    })
  }

  function snapshotBridge(): CanvasBridge {
    return {
      call: vi.fn(async (method: string) =>
        method === 'host.snapshot'
          ? { ok: true as const, result: asJsonText('{"contentVersion":7,"bytes":"Zm9v"}') }
          : { ok: true as const, result: asJsonText('{"dirty":false,"contentVersion":7}') }
      ),
      dispose: vi.fn()
    }
  }

  it('answers host.save by saving through the store and replying with the project-relative path', async () => {
    const { canvas, sent, stop } = harness()
    stopGateway = stop
    useProjectStore.setState({
      projects: [{ id: 'proj-1', name: 'p', color: 'blue', path: 'C:\\P' }]
    })
    setPhase('proj-1', { kind: 'ready', mount: { mountSeq: 4, info: INFO } })
    const bridge = snapshotBridge()
    useCanvasStore.getState().attachBridge('proj-1', 4, bridge)
    writeSnapshot.mockResolvedValue({
      success: true,
      data: {
        view: {
          mountSeq: 4,
          ready: true,
          dirty: false,
          contentVersion: '7',
          savedVersion: '7',
          saveError: null
        },
        markSaved: '7'
      }
    })

    hostSaveCall(canvas, 3, 4)
    await vi.waitFor(() => expect(sent.at(-1)?.[0]).toBe('canvas_reply'))
    expect(writeSnapshot).toHaveBeenCalledWith('proj-1', 4, '{"contentVersion":7,"bytes":"Zm9v"}')
    expect(bridge.call).not.toHaveBeenCalledWith('host.save', expect.anything())
    expect(sent.at(-1)).toEqual([
      'canvas_reply',
      { callId: 3, mountSeq: 4, ok: true, result: '{"path":"design.figcraft"}' }
    ])
    useCanvasStore.getState().detachBridge('proj-1', bridge)
  })

  it('answers host.save with ENGINE_ERROR and the save error when the write fails', async () => {
    const { canvas, sent, stop } = harness()
    stopGateway = stop
    setPhase('proj-1', { kind: 'ready', mount: { mountSeq: 4, info: INFO } })
    const bridge = snapshotBridge()
    useCanvasStore.getState().attachBridge('proj-1', 4, bridge)
    writeSnapshot.mockResolvedValue({ success: false, code: 'IO_ERROR', error: 'disk full' })

    hostSaveCall(canvas, 6, 4)
    await vi.waitFor(() => expect(sent.at(-1)?.[0]).toBe('canvas_reply'))
    expect(sent.at(-1)).toEqual([
      'canvas_reply',
      {
        callId: 6,
        mountSeq: 4,
        ok: false,
        error: { code: 'ENGINE_ERROR', message: 'IO_ERROR disk full' }
      }
    ])
    useCanvasStore.getState().detachBridge('proj-1', bridge)
  })

  it('answers host.save with CANVAS_CLOSED while the document is still loading', async () => {
    const { canvas, sent, stop } = harness()
    stopGateway = stop
    setPhase('proj-1', { kind: 'loading', mount: { mountSeq: 4, info: INFO } })

    hostSaveCall(canvas, 5, 4)
    await vi.waitFor(() => expect(sent.at(-1)?.[0]).toBe('canvas_reply'))
    expect(sent.at(-1)).toEqual([
      'canvas_reply',
      expect.objectContaining({
        callId: 5,
        ok: false,
        error: expect.objectContaining({ code: 'CANVAS_CLOSED' })
      })
    ])
    expect(writeSnapshot).not.toHaveBeenCalled()
  })
})
