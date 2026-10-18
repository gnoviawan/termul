/**
 * The host side of figcraft's control protocol over `postMessage` (spine
 * AD-25): the only channel between Termul and the embedded editor.
 *
 * Wire shape (as built in the fork, `apps/figcraft-web/src/bridge.rs`):
 * request `{id, method, params, mountSeq}` → reply `{id, ok, result | error:
 * {code, message}, mountSeq}`; events `{method: 'event.*', params, mountSeq}`.
 * `params` and `result` are JSON text, and this module never parses a
 * forwarded one: figcraft node ids are u64 and a JS number would round them.
 *
 * Per mount: request ids are allocated here only and increase from 1; every
 * envelope carries the mount's `mountSeq` and anything stamped with another
 * one is dropped; inbound messages are accepted only from the iframe's own
 * `contentWindow` at the canvas origin, and outbound ones target that origin
 * only. Calls made before `event.ready` wait in a queue, because the editor's
 * listener is not installed until its wasm starts. The renderer never times a
 * call out (AD-31); `dispose` resolves whatever is pending with
 * `CANVAS_CLOSED`.
 */

import {
  CANVAS_BRIDGE_ERROR_CODES,
  type CanvasBridgeErrorCode,
  type CanvasOpenInfo
} from '@shared/types/canvas.types'
import { logFrontendError } from './log-api'

declare const jsonTextBrand: unique symbol

/** JSON text carried through the bridge without being parsed. */
export type JsonText = string & { readonly [jsonTextBrand]: true }

export function asJsonText(text: string): JsonText {
  return text as JsonText
}

const EMPTY_PARAMS = asJsonText('{}')

export interface CanvasBridgeError {
  code: CanvasBridgeErrorCode
  message: string
}

export type CanvasBridgeReply =
  | { ok: true; result: JsonText }
  | { ok: false; error: CanvasBridgeError }

export type CanvasBridgeEvent =
  | { method: 'event.ready' }
  | { method: 'event.dirtyChanged'; dirty: boolean; contentVersion: JsonText }
  | { method: 'event.crashed'; reason: string }

export interface CanvasBridge {
  call(method: string, params?: JsonText): Promise<CanvasBridgeReply>
  dispose(): void
}

export interface CanvasBridgeOptions {
  iframe: HTMLIFrameElement
  /** Origin the editor is served from; the only one accepted and targeted. */
  canvasOrigin: string
  mountSeq: number
  onEvent: (event: CanvasBridgeEvent) => void
}

/** Method namespaces the editor answers; anything else is `UNKNOWN_METHOD`
 * without a round trip (`event.*` are editor → host only). */
const FORWARDED_NAMESPACES = new Set(['engine', 'document', 'node', 'ui', 'host'])

const BRIDGE_ERROR_CODES: ReadonlySet<string> = new Set(CANVAS_BRIDGE_ERROR_CODES)

export function bridgeFailure(code: CanvasBridgeErrorCode, message: string): CanvasBridgeReply {
  return { ok: false, error: { code, message } }
}

function isForwardedMethod(method: string): boolean {
  const dot = method.indexOf('.')
  return dot > 0 && dot < method.length - 1 && FORWARDED_NAMESPACES.has(method.slice(0, dot))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseReply(data: Record<string, unknown>): CanvasBridgeReply {
  if (data.ok === true && typeof data.result === 'string') {
    return { ok: true, result: asJsonText(data.result) }
  }
  if (data.ok === false && isRecord(data.error)) {
    const { code, message } = data.error
    return bridgeFailure(
      typeof code === 'string' && BRIDGE_ERROR_CODES.has(code)
        ? (code as CanvasBridgeErrorCode)
        : 'ENGINE_ERROR',
      typeof message === 'string' ? message : String(code)
    )
  }
  return bridgeFailure('ENGINE_ERROR', 'malformed reply from the editor')
}

/** The fork emits `{"dirty":<bool>,"contentVersion":<u64>}`; the version is
 * kept as its digits so it never passes through a JS number. */
function parseDirtyChanged(params: string): CanvasBridgeEvent | null {
  const dirty = /"dirty"\s*:\s*(true|false)/.exec(params)?.[1]
  const contentVersion = /"contentVersion"\s*:\s*(\d+)/.exec(params)?.[1]
  if (dirty === undefined || contentVersion === undefined) return null
  return {
    method: 'event.dirtyChanged',
    dirty: dirty === 'true',
    contentVersion: asJsonText(contentVersion)
  }
}

function parseCrashReason(params: string): string {
  try {
    const value: unknown = JSON.parse(params)
    if (isRecord(value) && typeof value.reason === 'string') return value.reason
  } catch {
    // An unreadable reason still reports the crash.
  }
  return 'unknown'
}

function parseEvent(method: string, params: unknown): CanvasBridgeEvent | null {
  const text = typeof params === 'string' ? params : ''
  switch (method) {
    case 'event.ready':
      return { method }
    case 'event.dirtyChanged':
      return parseDirtyChanged(text)
    case 'event.crashed':
      return { method, reason: parseCrashReason(text) }
    default:
      return null
  }
}

/** One agent canvas call the host gateway forwarded (spine AD-29). */
export interface GatewayCall {
  callId: number
  mountSeq: number
  method: string
  /** JSON text, forwarded unparsed. */
  params: string
}

export type GatewayReply =
  | { callId: number; mountSeq: number; ok: true; result: string }
  | { callId: number; mountSeq: number; ok: false; error: CanvasBridgeError }

/**
 * Run one gateway call in the editor mounted at `mountedSeq`. The gateway's
 * `callId` stays here, paired with the bridge request `run` allocates its own
 * id for, and the reply carries it back with the result as opaque text. A
 * call for another mount (the canvas was remounted or closed under it) is
 * `CANVAS_CLOSED` without reaching the editor. The host owns the timeout.
 */
export async function answerGatewayCall(
  call: GatewayCall,
  mountedSeq: number | null,
  run: (method: string, params: JsonText) => Promise<CanvasBridgeReply>
): Promise<GatewayReply> {
  const reply =
    mountedSeq === call.mountSeq
      ? await run(call.method, asJsonText(call.params))
      : bridgeFailure('CANVAS_CLOSED', 'the canvas this call was sent to is no longer mounted')
  const { callId, mountSeq } = call
  return reply.ok
    ? { callId, mountSeq, ok: true, result: reply.result }
    : { callId, mountSeq, ok: false, error: reply.error }
}

/** `''` (the web client's same-origin base) resolves to the page origin. */
export function canvasOriginOf(baseUrl: string): string {
  return baseUrl === '' ? window.location.origin : new URL(baseUrl).origin
}

/**
 * The iframe URL (AD-22). Set programmatically, never rendered as an
 * attribute or logged: it carries the `ct` token.
 */
export function buildCanvasEmbedUrl(
  target: Pick<CanvasOpenInfo, 'baseUrl' | 'canvasId' | 'canvasToken'>,
  hostOrigin: string,
  mountSeq: number
): string {
  const query = [
    'embed=kiosk',
    `ct=${encodeURIComponent(target.canvasToken)}`,
    `ho=${encodeURIComponent(hostOrigin)}`,
    `ms=${mountSeq}`
  ].join('&')
  return `${target.baseUrl}/canvas/${encodeURIComponent(target.canvasId)}/?${query}`
}

interface Envelope {
  id: number
  method: string
  params: JsonText
  mountSeq: number
}

export function createCanvasBridge(options: CanvasBridgeOptions): CanvasBridge {
  const { iframe, canvasOrigin, mountSeq, onEvent } = options
  const pending = new Map<number, (reply: CanvasBridgeReply) => void>()
  const queued: Envelope[] = []
  let nextId = 0
  let ready = false
  let disposed = false
  let staleLogged = false

  const post = (envelope: Envelope): void => {
    iframe.contentWindow?.postMessage(envelope, canvasOrigin)
  }

  const handleMessage = (event: MessageEvent): void => {
    if (event.origin !== canvasOrigin || event.source !== iframe.contentWindow) return
    const data: unknown = event.data
    if (!isRecord(data)) return
    if (data.mountSeq !== mountSeq) {
      if (!staleLogged) {
        staleLogged = true
        void logFrontendError({
          level: 'info',
          source: 'canvas-bridge.mountSeq',
          message: `dropped an editor message for another mount (bridge mountSeq ${mountSeq})`
        })
      }
      return
    }
    if (typeof data.id === 'number') {
      const resolve = pending.get(data.id)
      if (!resolve) return
      pending.delete(data.id)
      resolve(parseReply(data))
      return
    }
    if (typeof data.method !== 'string') return
    const parsed = parseEvent(data.method, data.params)
    if (parsed === null) return
    if (parsed.method === 'event.ready' && !ready) {
      ready = true
      for (const envelope of queued.splice(0)) post(envelope)
    }
    onEvent(parsed)
  }

  window.addEventListener('message', handleMessage)

  return {
    call(method: string, params: JsonText = EMPTY_PARAMS): Promise<CanvasBridgeReply> {
      if (disposed) return Promise.resolve(bridgeFailure('CANVAS_CLOSED', 'the canvas is closed'))
      if (!isForwardedMethod(method)) {
        return Promise.resolve(bridgeFailure('UNKNOWN_METHOD', `unknown method ${method}`))
      }
      nextId += 1
      const envelope: Envelope = { id: nextId, method, params, mountSeq }
      return new Promise<CanvasBridgeReply>((resolve) => {
        pending.set(envelope.id, resolve)
        if (ready) post(envelope)
        else queued.push(envelope)
      })
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      window.removeEventListener('message', handleMessage)
      queued.length = 0
      for (const resolve of pending.values()) {
        resolve(bridgeFailure('CANVAS_CLOSED', 'the canvas was unmounted'))
      }
      pending.clear()
    }
  }
}
