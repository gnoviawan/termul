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
 *
 * A mount this renderer no longer holds the lease of (spine AD-30) goes to the
 * lease-lost handler: the host says so with a `canvas_lease_lost` frame when
 * another window takes the canvas or the mount cap evicts it, or refuses the
 * re-report after a reconnect that came too late.
 */

import type { CanvasLeaseLoss } from '@shared/types/canvas.types'
import type {
  WsCanvasCallFrame,
  WsCanvasLeaseLostFrame,
  WsCanvasMountReply,
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

/** Runs one forwarded call in the mounted editor. Must not reject.
 * `deadline` (`Date.now()` ms) is when the host stops waiting for it. */
export type CanvasCallHandler = (
  call: WsCanvasCallFrame,
  deadline?: number
) => Promise<WsCanvasReplyPayload>

/** This renderer no longer holds `projectId`'s canvas at `mountSeq`. */
export type CanvasLeaseLostHandler = (
  projectId: string,
  mountSeq: number,
  loss: CanvasLeaseLoss
) => void

/**
 * Longest slice of a reply sent in one message, in UTF-16 units. The host's
 * socket takes at most 16 MiB a frame, and a unit is at most 3 bytes of UTF-8.
 */
export const REPLY_SLICE_UNITS = 4 * 1024 * 1024

/** End of the slice starting at `start`, never between a surrogate pair. */
function sliceEnd(text: string, start: number): number {
  const end = start + REPLY_SLICE_UNITS
  if (end >= text.length) return text.length
  const last = text.charCodeAt(end - 1)
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end
}

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
  private leaseLost: CanvasLeaseLostHandler | null = null

  constructor(private readonly transport: CanvasGatewayTransport) {}

  setCallHandler(handler: CanvasCallHandler | null): void {
    this.handler = handler
  }

  setLeaseLostHandler(handler: CanvasLeaseLostHandler | null): void {
    this.leaseLost = handler
  }

  /** This renderer holds `projectId`'s canvas at `mountSeq`, or no longer (`null`). */
  setMount(projectId: string, mountSeq: number | null): void {
    const held = this.mounts.get(projectId)
    if (mountSeq === null) {
      if (held === undefined) return
      this.mounts.delete(projectId)
      void this.send('canvas_unmount', { projectId, mountSeq: held })
      return
    }
    if (held === mountSeq) return
    this.mounts.set(projectId, mountSeq)
    this.report(projectId, mountSeq)
  }

  /** A new connection holds nothing until told again. */
  onConnected(): void {
    for (const [projectId, mountSeq] of this.mounts) this.report(projectId, mountSeq)
  }

  handleLeaseLost(frame: WsCanvasLeaseLostFrame): void {
    this.lose(frame.projectId, frame.mountSeq, frame.reason === 'evicted' ? 'evicted' : 'elsewhere')
  }

  private report(projectId: string, mountSeq: number): void {
    void this.send('canvas_mount', { projectId, mountSeq }).then((reply) => {
      const refused = reply as Partial<WsCanvasMountReply> | undefined
      if (refused?.attached !== false) return
      this.lose(projectId, mountSeq, refused.heldElsewhere ? 'elsewhere' : 'expired')
    })
  }

  private lose(projectId: string, mountSeq: number, loss: CanvasLeaseLoss): void {
    if (this.mounts.get(projectId) !== mountSeq) return
    this.mounts.delete(projectId)
    this.leaseLost?.(projectId, mountSeq, loss)
  }

  handleFrame(call: WsCanvasCallFrame): void {
    const handler = this.handler
    // The host's clock may differ from this one, so its wait is carried as
    // time left and turned into a local deadline on arrival.
    const deadline = call.timeoutMs === undefined ? undefined : Date.now() + call.timeoutMs
    const answer = handler
      ? handler(call, deadline).catch((error: unknown) => ({
          callId: call.callId,
          mountSeq: call.mountSeq,
          ok: false as const,
          error: { code: 'ENGINE_ERROR', message: String(error) }
        }))
      : Promise.resolve(closedReply(call, 'no canvas is mounted in this window'))
    void answer.then((reply) => this.sendReply(reply))
  }

  /**
   * A result longer than one slice goes as slices, each waiting for the host
   * to take the one before it, and stops when the host no longer wants them.
   */
  private async sendReply(reply: WsCanvasReplyPayload): Promise<void> {
    if (!reply.ok || reply.result.length <= REPLY_SLICE_UNITS) {
      await this.send('canvas_reply', reply)
      return
    }
    const { result } = reply
    let start = 0
    let end = sliceEnd(result, 0)
    while (end < result.length) {
      const taken = (await this.send('canvas_reply', {
        ...reply,
        result: result.slice(start, end),
        partial: true
      })) as { accepted?: boolean } | undefined
      if (taken?.accepted !== true) return
      start = end
      end = sliceEnd(result, start)
    }
    await this.send('canvas_reply', { ...reply, result: result.slice(start) })
  }

  /** The host's reply, or `undefined` when nothing was sent or it failed. */
  private send(type: CanvasRequestType, payload: unknown): Promise<unknown> {
    if (!this.transport.isLive()) return Promise.resolve(undefined)
    return this.transport.request(type, payload).catch((error: unknown) => {
      void logFrontendError({
        level: 'warn',
        source: `canvas-gateway.${type}`,
        message: `${type} failed: ${String(error)}`
      })
      return undefined
    })
  }
}
