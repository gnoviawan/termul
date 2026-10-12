/**
 * Contiguous event cursor for one session (the client half of the host's
 * `headSeq` contract).
 *
 * The host stamps every session event with a gap-free seq. A subscribe or
 * snapshot reply carries `headSeq`, the seq frontier at registration:
 *
 * - events with `seq <= headSeq` are REPLAY. The durable log skips seqs that
 *   were never persisted (non-durable events), so holes are allowed; apply them
 *   in order.
 * - events above `headSeq` are LIVE and must arrive as `last + 1`. Anything
 *   else means an event was lost on the way (the host dropped a LOSSY event for
 *   a slow peer, or a frame vanished): the client must not apply it and must
 *   install a snapshot instead. It never waits for the missing seq.
 */
import type { WsEvent } from '@shared/types/web-protocol.types'

export type EventVerdict = 'duplicate' | 'apply' | 'gap'

/**
 * Judge an event with `seq` against a cursor at `lastSeq` (last applied) and
 * `headSeq` (the registration frontier, `lastSeq` when none is known).
 */
export function judgeEvent(lastSeq: number, headSeq: number, seq: number): EventVerdict {
  if (seq <= lastSeq) return 'duplicate'
  if (seq <= headSeq) return 'apply'
  return seq === Math.max(lastSeq, headSeq) + 1 ? 'apply' : 'gap'
}

/** Held events a sync may buffer before the buffer is given up as lost. */
export const HELD_ITEM_LIMIT = 2_048

/** What arrived for a session while a subscribe/snapshot round trip was in flight. */
export type HeldItem = { kind: 'event'; evt: WsEvent } | { kind: 'gap' }

export interface SyncResult {
  /** Items to process in arrival order. */
  held: HeldItem[]
  /** The buffer overflowed: some items are missing, so the stream has a hole. */
  lost: boolean
  /** The cursor when the outermost sync began. */
  floorSeq: number
}

interface Sync {
  depth: number
  held: HeldItem[]
  lost: boolean
  floorSeq: number
}

/**
 * Per-session buffer for the window between sending a `subscribe` /
 * `recover_session_snapshot` request and installing its reply. Events can
 * overtake the reply on the wire; they are held until the reply says where the
 * replay ends, then judged against the new cursor.
 *
 * Syncs nest (a stale subscribe falls back to a snapshot); the buffer is
 * released only when the outermost one ends.
 */
export class SyncGate {
  private readonly syncs = new Map<string, Sync>()

  /** Start a sync; `floorSeq` is the session's cursor before it (outermost sync only). */
  begin(sessionId: string, floorSeq: number): void {
    const sync = this.syncs.get(sessionId)
    if (sync) {
      sync.depth += 1
      return
    }
    this.syncs.set(sessionId, { depth: 1, held: [], lost: false, floorSeq })
  }

  isSyncing(sessionId: string): boolean {
    return this.syncs.has(sessionId)
  }

  /** Hold `item` if the session is syncing. Returns whether it was held. */
  hold(sessionId: string, item: HeldItem): boolean {
    const sync = this.syncs.get(sessionId)
    if (!sync) return false
    if (sync.held.length >= HELD_ITEM_LIMIT) {
      sync.lost = true
      return true
    }
    sync.held.push(item)
    return true
  }

  /** End one sync level. The outermost end returns what was held. */
  end(sessionId: string): SyncResult | null {
    const sync = this.syncs.get(sessionId)
    if (!sync) return null
    sync.depth -= 1
    if (sync.depth > 0) return null
    this.syncs.delete(sessionId)
    return { held: sync.held, lost: sync.lost, floorSeq: sync.floorSeq }
  }
}
