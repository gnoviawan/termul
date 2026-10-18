/**
 * The renderer leg of the canvas gateway (spine AD-21, AD-29) on `/ws`, the
 * same on the desktop Channel and a browser socket.
 *
 * It tells the host which project canvases this renderer holds
 * (`canvas_mount` / `canvas_unmount`) and re-reports them on every
 * (re)connect, because the host keys a mount by connection. Each
 * `canvas_call` frame goes to the registered handler and its answer goes back
 * as `canvas_reply`. It never times a call out: the host owns the timeout, and
 * a reply the host no longer waits for is simply ignored there.
 */

import type {
  WsCanvasCallFrame,
  WsCanvasReplyPayload,
  WsRequestType
} from '@shared/types/web-protocol.types'
import { logFrontendError } from '@/lib/log-api'

type CanvasRequestType = Extract<WsRequestType, 'canvas_mount' | 'canvas_unmount' | 'canvas_reply'>

/** What the client needs from its transport. */
export interface CanvasGatewayTransport {
  request(type: CanvasRequestType, payload: unknown): Promise<unknown>
  /** Whether the socket is open and authenticated. */
  isLive(): boolean
}

/** Runs one forwarded call in the mounted editor. Must not reject. */
export type CanvasCallHandler = (call: WsCanvasCallFrame) => Promise<WsCanvasReplyPayload>

function closedReply(call: WsCanvasCallFrame, message: string): WsCanvasReplyPayload {
  return {
    callId: call.callId,
    mountSeq: call.mountSeq,
    ok: false,
    error: { code: 'CANVAS_CLOSED', message }
  }
}

export class CanvasGatewayClient {
  /** projectId → the mountSeq this renderer holds. */
  private readonly mounts = new Map<string, number>()
  private handler: CanvasCallHandler | null = null

  constructor(private readonly transport: CanvasGatewayTransport) {}

  setCallHandler(handler: CanvasCallHandler | null): void {
    this.handler = handler
  }

  /** This renderer holds `projectId`'s canvas at `mountSeq`, or no longer (`null`). */
  setMount(projectId: string, mountSeq: number | null): void {
    const held = this.mounts.get(projectId)
    if (mountSeq === null) {
      if (held === undefined) return
      this.mounts.delete(projectId)
      this.send('canvas_unmount', { projectId, mountSeq: held })
      return
    }
    if (held === mountSeq) return
    this.mounts.set(projectId, mountSeq)
    this.send('canvas_mount', { projectId, mountSeq })
  }

  /** A new connection holds nothing until told again. */
  onConnected(): void {
    for (const [projectId, mountSeq] of this.mounts) {
      this.send('canvas_mount', { projectId, mountSeq })
    }
  }

  handleFrame(call: WsCanvasCallFrame): void {
    const handler = this.handler
    const answer = handler
      ? handler(call).catch((error: unknown) => ({
          callId: call.callId,
          mountSeq: call.mountSeq,
          ok: false as const,
          error: { code: 'ENGINE_ERROR', message: String(error) }
        }))
      : Promise.resolve(closedReply(call, 'no canvas is mounted in this window'))
    void answer.then((reply) => this.send('canvas_reply', reply))
  }

  private send(type: CanvasRequestType, payload: unknown): void {
    if (!this.transport.isLive()) return
    this.transport.request(type, payload).catch((error: unknown) => {
      void logFrontendError({
        level: 'warn',
        source: `canvas-gateway.${type}`,
        message: `${type} failed: ${String(error)}`
      })
    })
  }
}
