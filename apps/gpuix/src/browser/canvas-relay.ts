/**
 * The FigCraft canvas in a helper webview, seen from `canvas-bridge.ts`. In the DOM clients the
 * bridge posts to the editor iframe's `contentWindow` and listens for `message` events from it on
 * `window`. Here the editor runs inside the helper's relay page (`native/webview-host/src/relay.html`),
 * so this module gives the bridge a frame whose `contentWindow.postMessage` sends the message to
 * the relay, and turns each message the relay forwards into a `message` event on `window` from
 * that same `contentWindow` at the editor's origin. The bridge runs unchanged on top.
 */

import type { BrowserHost } from '@/lib/browser-host'
import type { BrowserBounds, BrowserEventSubscription, IpcResult } from '@/lib/browser-types'
import type { CanvasFrame } from '@/lib/canvas-bridge'
import { log } from '../log'

/** The relay page's origin, which the editor is told is its host (`ho=`). */
export const CANVAS_RELAY_ORIGIN = 'termul-canvas://localhost'

/** What a host adds to the browser-pane set to run canvas webviews. */
export interface CanvasWebviewHost {
  /** A webview showing the relay page, which frames the editor at `url`. */
  createCanvas(tabId: string, url: string, bounds: BrowserBounds): Promise<IpcResult<void>>
  /** Deliver one message, as JSON text, to the tab's editor. */
  postToCanvas(tabId: string, data: string): Promise<IpcResult<void>>
  /** Messages the tab's editor posts to its parent, as JSON text. */
  onCanvasMessage(tabId: string, callback: (data: string) => void): BrowserEventSubscription
  /** Hand the keyboard back to the app if this tab holds it. */
  releaseKeyboard(tabId: string): void
}

export type CanvasCapableHost = BrowserHost & CanvasWebviewHost

export function isCanvasCapableHost(host: BrowserHost | null): host is CanvasCapableHost {
  return host !== null && 'createCanvas' in host && 'postToCanvas' in host
}

export interface CanvasRelayFrame {
  frame: CanvasFrame
  dispose(): void
}

/**
 * The frame `createCanvasBridge` talks to for canvas tab `tabId`. Like a real `postMessage`, a
 * message for another target origin is dropped. A relayed message that is not JSON is dropped
 * and logged; the bridge itself drops anything else it does not expect.
 */
export function createCanvasRelayFrame(
  host: CanvasWebviewHost,
  tabId: string,
  canvasOrigin: string
): CanvasRelayFrame {
  const contentWindow = {
    postMessage(message: unknown, targetOrigin: string): void {
      if (targetOrigin !== canvasOrigin) return
      void host.postToCanvas(tabId, JSON.stringify(message)).then((result) => {
        if (!result.success) log.warn('canvas', `post to ${tabId} failed: ${result.error}`)
      })
    }
  }
  const subscription = host.onCanvasMessage(tabId, (data) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      log.warn('canvas', `dropped an unreadable message from ${tabId}`)
      return
    }
    const event = new MessageEvent('message', { data: parsed })
    // MessageEvent's init only accepts real windows and ports as `source`.
    Object.defineProperty(event, 'origin', { value: canvasOrigin })
    Object.defineProperty(event, 'source', { value: contentWindow })
    window.dispatchEvent(event)
  })
  return { frame: { contentWindow }, dispose: () => subscription.unlisten() }
}

/** Left of the window by more than any slot is wide (X coordinates are 16-bit). */
export const OFFSCREEN_X = -16000

interface SlotRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where a canvas webview goes, in the window's logical pixels. It covers its slot while the tab
 * shows, as the DOM iframe does. Otherwise it moves out of the window rather than unmapping: an
 * unmapped WebKit view stops painting frames, and the editor answers bridge calls from its frame
 * loop, so agent calls on a hidden canvas would stall (the DOM client keeps a 1x1 offscreen
 * iframe for the same reason). Under an overlay it keeps its size, so the editor does not relayout
 * each time a menu opens; with no slot it shrinks to 1x1.
 */
export function canvasPlacement(
  slot: SlotRect | null,
  occluded: boolean,
  zoom: number
): BrowserBounds {
  if (!slot) return { x: OFFSCREEN_X, y: 0, width: 1, height: 1 }
  const bounds = {
    x: slot.left * zoom,
    y: slot.top * zoom,
    width: slot.width * zoom,
    height: slot.height * zoom
  }
  return occluded ? { ...bounds, x: OFFSCREEN_X } : bounds
}
