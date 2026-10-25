/**
 * The stdio protocol of `termul-webview-host` (`native/webview-host/src/protocol.rs`): one JSON
 * object per line. Commands carry a `req` the helper answers with one `ack`; everything else the
 * helper sends is an event about a tab or about keyboard ownership.
 */

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

type TabOp = 'show' | 'hide' | 'back' | 'forward' | 'reload' | 'devtools' | 'destroy'

/** A command without its `req`; the process wrapper numbers it. */
export type HostRequest =
  | { op: 'create'; id: string; url: string; bounds: Bounds }
  /** A canvas tab: the helper's relay page frames `url` and passes messages both ways. */
  | { op: 'createCanvas'; id: string; url: string; bounds: Bounds }
  /** Deliver one message (JSON text) to a canvas tab's framed editor. */
  | { op: 'post'; id: string; data: string }
  | { op: 'bounds'; id: string; bounds: Bounds }
  | { op: 'navigate'; id: string; url: string }
  | { op: TabOp; id: string }
  /** Give the keyboard back to the app window. */
  | { op: 'blur' }

export type HostCommand = (HostRequest & { req: number }) | { op: 'quit' }

export type HostEvent =
  | { ev: 'ready'; parent: number; pid: number }
  | { ev: 'ack'; req: number; ok: true }
  | { ev: 'ack'; req: number; ok: false; error: string }
  | { ev: 'navigated'; id: string; url: string }
  | { ev: 'loaded'; id: string; url: string }
  | { ev: 'title'; id: string; title: string }
  | { ev: 'console'; id: string; level: string; text: string }
  /** A message a canvas tab's editor posted to its parent, as JSON text. */
  | { ev: 'canvasMessage'; id: string; data: string }
  /** The tab holding the keyboard; `null` means the app window. */
  | { ev: 'keyboard'; owner: string | null }
  | { ev: 'fatal'; error: string }
  | { ev: 'invalid'; line: string; error: string }

export function encodeCommand(command: HostCommand): string {
  return `${JSON.stringify(command)}\n`
}

type Fields = Record<string, unknown>

const str = (o: Fields, key: string): boolean => typeof o[key] === 'string'
const num = (o: Fields, key: string): boolean =>
  typeof o[key] === 'number' && Number.isFinite(o[key])

/** One line from the helper, or `null` when it is not a well-formed event. */
export function parseEvent(line: string): HostEvent | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const o = value as Fields
  switch (o.ev) {
    case 'ready':
      return num(o, 'parent') && num(o, 'pid')
        ? { ev: 'ready', parent: o.parent as number, pid: o.pid as number }
        : null
    case 'ack':
      if (!num(o, 'req')) return null
      if (o.ok === true) return { ev: 'ack', req: o.req as number, ok: true }
      return o.ok === false && str(o, 'error')
        ? { ev: 'ack', req: o.req as number, ok: false, error: o.error as string }
        : null
    case 'navigated':
    case 'loaded':
      return str(o, 'id') && str(o, 'url')
        ? { ev: o.ev, id: o.id as string, url: o.url as string }
        : null
    case 'title':
      return str(o, 'id') && str(o, 'title')
        ? { ev: 'title', id: o.id as string, title: o.title as string }
        : null
    case 'console':
      return str(o, 'id') && str(o, 'level') && str(o, 'text')
        ? { ev: 'console', id: o.id as string, level: o.level as string, text: o.text as string }
        : null
    case 'canvasMessage':
      return str(o, 'id') && str(o, 'data')
        ? { ev: 'canvasMessage', id: o.id as string, data: o.data as string }
        : null
    case 'keyboard':
      return o.owner === null || str(o, 'owner')
        ? { ev: 'keyboard', owner: o.owner as string | null }
        : null
    case 'fatal':
      return str(o, 'error') ? { ev: 'fatal', error: o.error as string } : null
    case 'invalid':
      return str(o, 'line') && str(o, 'error')
        ? { ev: 'invalid', line: o.line as string, error: o.error as string }
        : null
    default:
      return null
  }
}
