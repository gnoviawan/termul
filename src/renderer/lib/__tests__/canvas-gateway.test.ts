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
import { asJsonText, type CanvasBridge } from '@/lib/canvas-bridge'
import { type CanvasPhase, useCanvasStore } from '@/stores/canvas-store'
import { useProjectStore } from '@/stores/project-store'
import { projectRelativePath, startCanvasGateway } from '../canvas-gateway'

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
    expect(bridge.call).toHaveBeenCalledWith('node.get', '{"id":18446744073709551615}')
    expect(sent.at(-1)).toEqual([
      'canvas_reply',
      { callId: 8, mountSeq: 5, ok: true, result: '{"id":18446744073709551615}' }
    ])
    useCanvasStore.getState().detachBridge('proj-1', bridge)
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

describe('projectRelativePath', () => {
  it('strips the project root, folding case and separators for drive paths', () => {
    expect(projectRelativePath('C:/p/design/app.figcraft', 'c:\\P\\')).toBe('design/app.figcraft')
    expect(projectRelativePath('/home/u/p/a.figcraft', '/home/u/p')).toBe('a.figcraft')
  })

  it('keeps the full path for a document outside the root or with no root', () => {
    expect(projectRelativePath('/home/u/other/a.figcraft', '/home/u/p')).toBe(
      '/home/u/other/a.figcraft'
    )
    expect(projectRelativePath('/home/u/pp/a.figcraft', '/home/u/p')).toBe('/home/u/pp/a.figcraft')
    expect(projectRelativePath('C:\\p\\a.figcraft', undefined)).toBe('C:/p/a.figcraft')
  })
})
