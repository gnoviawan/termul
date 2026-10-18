/**
 * The host side of figcraft's control protocol (spine AD-25), driven the way
 * the editor iframe drives it: object envelopes posted from the iframe's
 * `contentWindow` at the canvas origin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

import {
  answerGatewayCall,
  asJsonText,
  buildCanvasEmbedUrl,
  type CanvasBridge,
  type CanvasBridgeEvent,
  canvasOriginOf,
  createCanvasBridge
} from '../canvas-bridge'

const CANVAS_ORIGIN = 'http://127.0.0.1:5199'
const MOUNT_SEQ = 7

interface FakeEditor {
  iframe: HTMLIFrameElement
  posted: ReturnType<typeof vi.fn>
  send(data: unknown, from?: { origin?: string; source?: unknown }): void
  ready(): void
  lastRequest(): { id: number; method: string; params: string; mountSeq: number }
}

function fakeEditor(): FakeEditor {
  const posted = vi.fn()
  const contentWindow = { postMessage: posted } as unknown as Window
  const iframe = { contentWindow } as unknown as HTMLIFrameElement
  const send: FakeEditor['send'] = (data, from = {}) => {
    const event = new MessageEvent('message', { data })
    Object.defineProperty(event, 'origin', { value: from.origin ?? CANVAS_ORIGIN })
    Object.defineProperty(event, 'source', {
      value: 'source' in from ? from.source : contentWindow
    })
    window.dispatchEvent(event)
  }
  return {
    iframe,
    posted,
    send,
    ready: () => send({ method: 'event.ready', params: '{}', mountSeq: MOUNT_SEQ }),
    lastRequest: () => posted.mock.calls.at(-1)?.[0]
  }
}

describe('buildCanvasEmbedUrl', () => {
  it('builds the AD-22 kiosk URL with the host origin and mount sequence', () => {
    expect(
      buildCanvasEmbedUrl(
        { baseUrl: 'http://127.0.0.1:5199', canvasId: 'cv0123456789abcdef', canvasToken: 'ab12' },
        'http://tauri.localhost',
        3
      )
    ).toBe(
      'http://127.0.0.1:5199/canvas/cv0123456789abcdef/?embed=kiosk&ct=ab12&ho=http%3A%2F%2Ftauri.localhost&ms=3'
    )
  })

  it('stays path-relative on the web client, where the base is empty', () => {
    expect(
      buildCanvasEmbedUrl(
        { baseUrl: '', canvasId: 'cv1', canvasToken: 'ff' },
        'https://termul.example',
        1
      )
    ).toBe('/canvas/cv1/?embed=kiosk&ct=ff&ho=https%3A%2F%2Ftermul.example&ms=1')
  })
})

describe('canvasOriginOf', () => {
  it('is the loopback origin on desktop and the page origin on the web', () => {
    expect(canvasOriginOf('http://127.0.0.1:5199')).toBe(CANVAS_ORIGIN)
    expect(canvasOriginOf('')).toBe(window.location.origin)
  })
})

describe('createCanvasBridge', () => {
  let editor: FakeEditor
  let events: CanvasBridgeEvent[]
  let bridge: CanvasBridge

  beforeEach(() => {
    editor = fakeEditor()
    events = []
    bridge = createCanvasBridge({
      iframe: editor.iframe,
      canvasOrigin: CANVAS_ORIGIN,
      mountSeq: MOUNT_SEQ,
      onEvent: (event) => events.push(event)
    })
  })

  afterEach(() => {
    bridge.dispose()
  })

  it('holds calls until event.ready, then posts them with increasing ids to the canvas origin', async () => {
    const first = bridge.call('document.inspect')
    const second = bridge.call('engine.commands')
    expect(editor.posted).not.toHaveBeenCalled()

    editor.ready()
    expect(events).toEqual([{ method: 'event.ready' }])
    expect(editor.posted.mock.calls).toEqual([
      [{ id: 1, method: 'document.inspect', params: '{}', mountSeq: MOUNT_SEQ }, CANVAS_ORIGIN],
      [{ id: 2, method: 'engine.commands', params: '{}', mountSeq: MOUNT_SEQ }, CANVAS_ORIGIN]
    ])

    editor.send({ id: 2, ok: true, result: '[]', mountSeq: MOUNT_SEQ })
    editor.send({ id: 1, ok: true, result: '{"pages":[]}', mountSeq: MOUNT_SEQ })
    await expect(first).resolves.toEqual({ ok: true, result: '{"pages":[]}' })
    await expect(second).resolves.toEqual({ ok: true, result: '[]' })

    void bridge.call('node.get', asJsonText('{"id":1}'))
    expect(editor.lastRequest().id).toBe(3)
  })

  it('forwards params and results as untouched JSON text, so 64-bit node ids survive', async () => {
    editor.ready()
    const params = '{"command":"object.setName","params":{"id":18446744073709551615,"name":"x"}}'
    const reply = bridge.call('engine.execute', asJsonText(params))

    const request = editor.lastRequest()
    expect(request.params).toBe(params)

    const result = '{"id":18446744073709551615,"parent":9007199254740993}'
    editor.send({ id: request.id, ok: true, result, mountSeq: MOUNT_SEQ })
    const resolved = await reply
    expect(resolved).toEqual({ ok: true, result })
    expect(resolved.ok && resolved.result.includes('18446744073709551615')).toBe(true)
  })

  it('accepts only the iframe window at the canvas origin', async () => {
    editor.ready()
    const reply = bridge.call('document.inspect')
    const { id } = editor.lastRequest()
    const forged = { id, ok: true, result: '"forged"', mountSeq: MOUNT_SEQ }

    editor.send(forged, { origin: 'http://evil.example' })
    editor.send(forged, { source: window })
    editor.send(forged, { source: null })
    editor.send({ id, ok: true, result: '"real"', mountSeq: MOUNT_SEQ })

    await expect(reply).resolves.toEqual({ ok: true, result: '"real"' })
  })

  it('drops replies and events stamped with another mountSeq', async () => {
    editor.ready()
    const reply = bridge.call('document.inspect')
    const { id } = editor.lastRequest()
    let settled = false
    void reply.then(() => {
      settled = true
    })

    editor.send({ id, ok: true, result: '"stale"', mountSeq: MOUNT_SEQ - 1 })
    editor.send({ method: 'event.crashed', params: '{"reason":"old"}', mountSeq: MOUNT_SEQ - 1 })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(events).toEqual([{ method: 'event.ready' }])

    editor.send({ id, ok: true, result: '"current"', mountSeq: MOUNT_SEQ })
    await expect(reply).resolves.toEqual({ ok: true, result: '"current"' })
  })

  it('answers UNKNOWN_METHOD locally for methods outside the protocol', async () => {
    editor.ready()
    for (const method of ['event.ready', 'app.quit', 'window.close', 'bogus', 'engine.']) {
      await expect(bridge.call(method)).resolves.toEqual({
        ok: false,
        error: { code: 'UNKNOWN_METHOD', message: `unknown method ${method}` }
      })
    }
    expect(editor.posted).not.toHaveBeenCalled()
  })

  it('passes typed editor errors through and maps unknown codes to ENGINE_ERROR', async () => {
    editor.ready()
    const hidden = bridge.call('ui.inspect')
    editor.send({
      id: editor.lastRequest().id,
      ok: false,
      error: { code: 'CANVAS_HIDDEN', message: 'off screen' },
      mountSeq: MOUNT_SEQ
    })
    await expect(hidden).resolves.toEqual({
      ok: false,
      error: { code: 'CANVAS_HIDDEN', message: 'off screen' }
    })

    const odd = bridge.call('engine.execute')
    editor.send({
      id: editor.lastRequest().id,
      ok: false,
      error: { code: 'SOMETHING_NEW', message: 'boom' },
      mountSeq: MOUNT_SEQ
    })
    await expect(odd).resolves.toEqual({
      ok: false,
      error: { code: 'ENGINE_ERROR', message: 'boom' }
    })
  })

  it('keeps contentVersion as text and reports crashes', () => {
    editor.ready()
    editor.send({
      method: 'event.dirtyChanged',
      params: '{"dirty":true,"contentVersion":18446744073709551615}',
      mountSeq: MOUNT_SEQ
    })
    editor.send({ method: 'event.crashed', params: '{"reason":"panic"}', mountSeq: MOUNT_SEQ })
    editor.send({ method: 'event.selectionChanged', params: '{}', mountSeq: MOUNT_SEQ })
    expect(events).toEqual([
      { method: 'event.ready' },
      { method: 'event.dirtyChanged', dirty: true, contentVersion: '18446744073709551615' },
      { method: 'event.crashed', reason: 'panic' }
    ])
  })

  it('resolves pending and later calls with CANVAS_CLOSED once disposed', async () => {
    const queued = bridge.call('document.inspect')
    editor.ready()
    const inFlight = bridge.call('engine.commands')
    bridge.dispose()

    const closed = { ok: false, error: { code: 'CANVAS_CLOSED', message: expect.any(String) } }
    await expect(queued).resolves.toEqual(closed)
    await expect(inFlight).resolves.toEqual(closed)
    await expect(bridge.call('document.inspect')).resolves.toEqual(closed)

    editor.send({ method: 'event.crashed', params: '{}', mountSeq: MOUNT_SEQ })
    expect(events).toEqual([{ method: 'event.ready' }])
  })
})

describe('answerGatewayCall', () => {
  let editor: FakeEditor
  let bridge: CanvasBridge

  beforeEach(() => {
    editor = fakeEditor()
    bridge = createCanvasBridge({
      iframe: editor.iframe,
      canvasOrigin: CANVAS_ORIGIN,
      mountSeq: MOUNT_SEQ,
      onEvent: () => {}
    })
    editor.ready()
  })

  afterEach(() => {
    bridge.dispose()
  })

  it('maps the gateway callId onto a bridge request and returns the result text unparsed', async () => {
    const call = {
      callId: 41,
      mountSeq: MOUNT_SEQ,
      method: 'node.get',
      params: '{"id":18446744073709551615}'
    }
    const answer = answerGatewayCall(call, MOUNT_SEQ, (method, params) =>
      bridge.call(method, params)
    )
    const request = editor.lastRequest()
    expect(request).toEqual({
      id: 1,
      method: 'node.get',
      params: '{"id":18446744073709551615}',
      mountSeq: MOUNT_SEQ
    })
    editor.send({
      id: request.id,
      ok: true,
      result: '{"id":18446744073709551615}',
      mountSeq: MOUNT_SEQ
    })
    await expect(answer).resolves.toEqual({
      callId: 41,
      mountSeq: MOUNT_SEQ,
      ok: true,
      result: '{"id":18446744073709551615}'
    })
  })

  it('carries a typed editor error back under the gateway callId', async () => {
    const answer = answerGatewayCall(
      { callId: 5, mountSeq: MOUNT_SEQ, method: 'ui.screenshot', params: '{}' },
      MOUNT_SEQ,
      (method, params) => bridge.call(method, params)
    )
    editor.send({
      id: editor.lastRequest().id,
      ok: false,
      error: { code: 'CANVAS_HIDDEN', message: 'hidden' },
      mountSeq: MOUNT_SEQ
    })
    await expect(answer).resolves.toEqual({
      callId: 5,
      mountSeq: MOUNT_SEQ,
      ok: false,
      error: { code: 'CANVAS_HIDDEN', message: 'hidden' }
    })
  })

  it('answers CANVAS_CLOSED without reaching the editor when the call targets another mount', async () => {
    const answer = answerGatewayCall(
      { callId: 9, mountSeq: MOUNT_SEQ - 1, method: 'document.inspect', params: '{}' },
      MOUNT_SEQ,
      (method, params) => bridge.call(method, params)
    )
    await expect(answer).resolves.toMatchObject({
      callId: 9,
      ok: false,
      error: { code: 'CANVAS_CLOSED' }
    })
    expect(editor.posted).not.toHaveBeenCalled()
  })
})
