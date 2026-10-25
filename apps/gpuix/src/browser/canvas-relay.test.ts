import { beforeAll, describe, expect, test } from 'bun:test'
import type { BrowserEventSubscription, IpcResult } from '@/lib/browser-types'
import {
  type CanvasWebviewHost,
  canvasPlacement,
  createCanvasRelayFrame,
  OFFSCREEN_X,
  type RelayFrame
} from './canvas-relay'

const ORIGIN = 'http://127.0.0.1:8190'

beforeAll(() => {
  if (typeof window === 'undefined') Object.assign(globalThis, { window: new EventTarget() })
})

/** The helper side of one canvas tab: what was posted to it, and a way to relay editor messages. */
function fakeHost() {
  const posted: { tabId: string; data: string }[] = []
  const listeners = new Map<string, (data: string) => void>()
  const goneListeners = new Map<string, (reason: string) => void>()
  const host: CanvasWebviewHost = {
    createCanvas: async () => ({ success: true, data: undefined }),
    async postToCanvas(tabId, data): Promise<IpcResult<void>> {
      posted.push({ tabId, data })
      return { success: true, data: undefined }
    },
    onCanvasMessage(tabId, callback): BrowserEventSubscription {
      listeners.set(tabId, callback)
      return { unlisten: () => listeners.delete(tabId) }
    },
    onCanvasGone(tabId, callback): BrowserEventSubscription {
      goneListeners.set(tabId, callback)
      return { unlisten: () => goneListeners.delete(tabId) }
    },
    releaseKeyboard: () => {}
  }
  const relay = (tabId: string, message: unknown) => listeners.get(tabId)?.(JSON.stringify(message))
  return { host, posted, relay, listeners, goneListeners }
}

/** What `createCanvasBridge` sees: `message` events on window, filtered as it filters them. */
function bridgeView(frame: RelayFrame, origin: string) {
  const seen: unknown[] = []
  const listener = (event: Event) => {
    const message = event as MessageEvent
    if (message.origin === origin && message.source === frame.contentWindow) seen.push(message.data)
  }
  window.addEventListener('message', listener)
  return { seen, stop: () => window.removeEventListener('message', listener) }
}

describe('canvas relay frame', () => {
  test('a post reaches the helper as JSON text, with u64 ids still digits inside params', () => {
    const { host, posted } = fakeHost()
    const frame = createCanvasRelayFrame(host, 'canvas-p1-3', ORIGIN, 3)
    frame.frame.contentWindow?.postMessage(
      { id: 1, method: 'node.get', params: '{"id":18446744073709551615}', mountSeq: 3 },
      ORIGIN
    )
    expect(posted).toEqual([
      {
        tabId: 'canvas-p1-3',
        data: '{"id":1,"method":"node.get","params":"{\\"id\\":18446744073709551615}","mountSeq":3}'
      }
    ])
    frame.dispose()
  })

  test("the editor's messages arrive on window from the frame's contentWindow at the editor origin", () => {
    const { host, relay } = fakeHost()
    const frame = createCanvasRelayFrame(host, 'canvas-p1-4', ORIGIN, 4)
    const view = bridgeView(frame.frame, ORIGIN)
    relay('canvas-p1-4', { method: 'event.ready', params: '{}', mountSeq: 4 })
    relay('canvas-p1-4', { id: 1, ok: true, result: '{"name":"Frame 1"}', mountSeq: 4 })
    expect(view.seen).toEqual([
      { method: 'event.ready', params: '{}', mountSeq: 4 },
      { id: 1, ok: true, result: '{"name":"Frame 1"}', mountSeq: 4 }
    ])
    view.stop()
    frame.dispose()
  })

  test('other tabs, unreadable relays and a disposed frame deliver nothing', () => {
    const { host, relay, listeners } = fakeHost()
    const frame = createCanvasRelayFrame(host, 'canvas-p1-5', ORIGIN, 5)
    const view = bridgeView(frame.frame, ORIGIN)
    relay('canvas-other', { method: 'event.ready', params: '{}', mountSeq: 5 })
    listeners.get('canvas-p1-5')?.('not json')
    frame.dispose()
    relay('canvas-p1-5', { method: 'event.ready', params: '{}', mountSeq: 5 })
    expect(view.seen).toEqual([])
    expect(listeners.has('canvas-p1-5')).toBe(false)
    view.stop()
  })

  test('a webview gone under the editor reaches the bridge as event.crashed for its mount', () => {
    const { host, goneListeners } = fakeHost()
    const frame = createCanvasRelayFrame(host, 'canvas-p1-7', ORIGIN, 7)
    const view = bridgeView(frame.frame, ORIGIN)
    goneListeners.get('canvas-p1-7')?.('webview host killed by SIGKILL')
    expect(view.seen).toEqual([
      {
        method: 'event.crashed',
        params: '{"reason":"webview host killed by SIGKILL"}',
        mountSeq: 7
      }
    ])
    view.stop()
    frame.dispose()
    expect(goneListeners.has('canvas-p1-7')).toBe(false)
  })

  test('a post for another target origin is dropped, as postMessage drops it', () => {
    const { host, posted } = fakeHost()
    const frame = createCanvasRelayFrame(host, 'canvas-p1-6', ORIGIN, 6)
    frame.frame.contentWindow?.postMessage({ id: 1 }, 'http://evil.example')
    frame.frame.contentWindow?.postMessage({ id: 2 }, ORIGIN)
    expect(posted).toEqual([{ tabId: 'canvas-p1-6', data: '{"id":2}' }])
    frame.dispose()
  })
})

describe('canvasPlacement', () => {
  const slot = { left: 100, top: 80, width: 600, height: 400 }

  test('covers the slot, scaled by the UI zoom', () => {
    expect(canvasPlacement(slot, false, 1.25)).toEqual({ x: 125, y: 100, width: 750, height: 500 })
  })

  test('an overlay moves it out of the window at its size; no slot shrinks it to 1x1', () => {
    expect(canvasPlacement(slot, true, 1)).toEqual({
      x: OFFSCREEN_X,
      y: 80,
      width: 600,
      height: 400
    })
    expect(canvasPlacement(null, false, 1)).toEqual({ x: OFFSCREEN_X, y: 0, width: 1, height: 1 })
  })
})
