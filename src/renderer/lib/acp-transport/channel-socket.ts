/**
 * `ChannelSocket` — a minimal WebSocket-shaped carrier over the Tauri IPC
 * bridge (E6, "one carrier for desktop").
 *
 * The desktop host runs the SAME relay loop it serves on `/ws`, reached through
 * three commands instead of a socket:
 *
 * - `ws_channel_open({ onFrame })` opens one relay connection and returns its
 *   id. `onFrame` is a Tauri `Channel`: it delivers ONE string per message —
 *   exactly the JSON text a `/ws` socket would carry (reply, single event,
 *   `{"type":"events"}` batch, heartbeat/gap frames), in the relay's single
 *   ordered outbound order.
 * - `ws_channel_send({ connectionId, frame })` enqueues ONE inbound frame. It
 *   only acknowledges the enqueue; the reply arrives on the Channel.
 * - `ws_channel_close({ connectionId })` ends the connection (idempotent).
 *
 * When the HOST ends a connection it sends a final
 * `{"type":"channel_closed","code","reason"}` frame. That frame is consumed
 * here (never handed to the protocol layer) and becomes `onclose`. The Tauri
 * JS `Channel` exposes no end-of-stream hook, so a host that vanishes without
 * that frame is detected the way a half-open socket is: by the transport's
 * liveness checks and by the next `ws_channel_send` rejecting (unknown/closed
 * connection → `onerror` + `onclose(1006)`).
 *
 * Only the WebSocket surface `WsAcpTransport` uses is implemented:
 * `readyState`, `send`, `close`, `onopen`/`onmessage`/`onerror`/`onclose`.
 * No Ping/Pong exists on this carrier: liveness is the protocol's own `ping`
 * request and `background`/`foreground` frames.
 */

import { Channel, invoke } from '@tauri-apps/api/core'
import { logFrontendError } from '@/lib/log-api'

const SOURCE = 'ChannelSocket'

/** The `/ws` abnormal-closure code, used for any non-host-initiated loss. */
const CLOSE_ABNORMAL = 1006
const CLOSE_NORMAL = 1000

interface ChannelMessageEvent {
  data: string
}

interface ChannelCloseEvent {
  code: number
  reason: string
  wasClean: boolean
}

/** Host-sent terminal frame (`code` 1001 = host stop, mirroring `Close(1001)`). */
interface ChannelClosedFrame {
  type: 'channel_closed'
  code?: unknown
  reason?: unknown
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The relay text is JSON, so the plain-text frame is a string. A Tauri build
 * that surfaces already-parsed JSON for a `Json` body is normalized back to
 * its text so the protocol layer always sees what `/ws` would have carried.
 */
function frameText(raw: unknown): string {
  return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

function parseClosedFrame(text: string): ChannelClosedFrame | null {
  // Cheap pre-filter: every other frame skips the JSON parse (the parse below
  // stays authoritative, so a chat message that merely mentions the word
  // cannot be mistaken for the terminal frame).
  if (!text.includes('"channel_closed"')) return null
  try {
    const parsed = JSON.parse(text) as ChannelClosedFrame | null
    return parsed && typeof parsed === 'object' && parsed.type === 'channel_closed' ? parsed : null
  } catch {
    return null
  }
}

export class ChannelSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState: number = ChannelSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: ChannelMessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: ChannelCloseEvent) => void) | null = null

  private connectionId: number | null = null
  /** Frames that arrived before `ws_channel_open` resolved (the relay speaks first). */
  private early: string[] = []
  /** Serializes `ws_channel_send`: IPC invokes may complete out of order, so each waits for the previous ack. */
  private sendTail: Promise<void> = Promise.resolve()
  private closeNotified = false

  /** `url` exists only for `WebSocketImpl` shape compatibility; the carrier has no endpoint. */
  constructor(public readonly url: string = 'channel://desktop') {
    const channel = new Channel<unknown>()
    channel.onmessage = (raw) => this.receive(frameText(raw))
    invoke<number>('ws_channel_open', { onFrame: channel }).then(
      (id) => this.opened(id),
      (err) => {
        void logFrontendError({
          level: 'warn',
          source: SOURCE,
          message: `ws_channel_open failed: ${describeError(err)}`
        })
        this.onerror?.(new Event('error'))
        this.finish(CLOSE_ABNORMAL, 'channel open failed', false)
      }
    )
  }

  send(text: string): void {
    if (this.readyState === ChannelSocket.CONNECTING) {
      throw new Error('ChannelSocket is still connecting')
    }
    // Like a WebSocket: data sent while CLOSING/CLOSED is discarded.
    if (this.readyState !== ChannelSocket.OPEN) return
    this.sendTail = this.sendTail.then(() => this.sendOne(text))
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= ChannelSocket.CLOSING) return
    const wasConnecting = this.readyState === ChannelSocket.CONNECTING
    this.readyState = ChannelSocket.CLOSING
    // A connect still in flight closes itself from `opened`.
    if (wasConnecting) return
    this.sendTail = this.sendTail.then(() => this.closeHost(code ?? CLOSE_NORMAL, reason ?? ''))
  }

  private opened(id: number): void {
    this.connectionId = id
    if (this.readyState === ChannelSocket.CLOSING) {
      void this.closeHost(CLOSE_NORMAL, '')
      return
    }
    if (this.readyState !== ChannelSocket.CONNECTING) return
    this.readyState = ChannelSocket.OPEN
    this.onopen?.(new Event('open'))
    const early = this.early
    this.early = []
    for (const text of early) this.deliver(text)
  }

  private receive(text: string): void {
    if (this.readyState === ChannelSocket.CONNECTING) {
      this.early.push(text)
      return
    }
    this.deliver(text)
  }

  private deliver(text: string): void {
    if (this.readyState !== ChannelSocket.OPEN) return
    const closed = parseClosedFrame(text)
    if (closed) {
      const code = typeof closed.code === 'number' ? closed.code : CLOSE_ABNORMAL
      const reason = typeof closed.reason === 'string' ? closed.reason : ''
      void logFrontendError({
        level: 'info',
        source: SOURCE,
        message: `host closed the channel (code ${code}${reason ? `: ${reason}` : ''})`
      })
      this.finish(code, reason, true)
      return
    }
    this.onmessage?.({ data: text })
  }

  private async sendOne(frame: string): Promise<void> {
    // CLOSING still flushes: `close()` queues behind frames accepted before it.
    if (this.readyState === ChannelSocket.CLOSED || this.connectionId === null) return
    try {
      await invoke('ws_channel_send', { connectionId: this.connectionId, frame })
    } catch (err) {
      // An unknown/closed connection or a full inbound queue: the frame is
      // gone, so the ordered stream can no longer be trusted. Drop the
      // connection; the protocol layer reconnects and resends by commandId.
      void logFrontendError({
        level: 'warn',
        source: SOURCE,
        message: `ws_channel_send failed: ${describeError(err)}`
      })
      if (this.readyState !== ChannelSocket.CLOSED) {
        this.onerror?.(new Event('error'))
        this.finish(CLOSE_ABNORMAL, 'channel send failed', false)
        await this.releaseHost()
      }
    }
  }

  private async closeHost(code: number, reason: string): Promise<void> {
    await this.releaseHost()
    this.finish(code, reason, true)
  }

  /** Best-effort, idempotent host-side close (never throws). */
  private async releaseHost(): Promise<void> {
    if (this.connectionId === null) return
    try {
      await invoke('ws_channel_close', { connectionId: this.connectionId })
    } catch (err) {
      void logFrontendError({
        level: 'warn',
        source: SOURCE,
        message: `ws_channel_close failed: ${describeError(err)}`
      })
    }
  }

  private finish(code: number, reason: string, wasClean: boolean): void {
    this.readyState = ChannelSocket.CLOSED
    this.early = []
    if (this.closeNotified) return
    this.closeNotified = true
    this.onclose?.({ code, reason, wasClean })
  }
}
