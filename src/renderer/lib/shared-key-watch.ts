/**
 * Decides which store-watch frames of a key this page must apply.
 *
 * The host sends every writer, this page included, the value a key holds
 * after each change. A frame is applied only when it tells this page
 * something it does not already hold:
 *  - never before the key was read once (the watch itself starts after that
 *    read, so the first frame can only carry newer state), and never while its
 *    last read failed;
 *  - not when it equals the value this page last read, wrote or applied, or is
 *    writing right now (the echo of its own write, which can arrive before the
 *    write reply);
 *  - a frame that differs is applied and becomes the value this page holds.
 *
 * Applying never writes: the caller's listener only updates in-memory state.
 */

import { type PersistenceKeyChange } from '@shared/types/ipc.types'

type KeyChange = PersistenceKeyChange

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]))
    )
  }
  return false
}

function sameChange(a: KeyChange | undefined, b: KeyChange): boolean {
  if (!a || a.exists !== b.exists) return false
  return !a.exists || deepEqual(a.data, b.data)
}

/** Starts the host watch of one scoped key; returns its unsubscribe. */
export type WatchSubscribe = (key: string, onChange: (change: KeyChange) => void) => () => void

export class SharedWatchTracker {
  /** Host keys read successfully, and not failed since. */
  private readonly hydrated = new Set<string>()
  /** What this page holds per host key (last read, confirmed write or applied frame). */
  private readonly known = new Map<string, KeyChange>()
  /** The value of a write sent and not yet answered. */
  private readonly sending = new Map<string, KeyChange>()
  /** Watches waiting for the first read of their key. */
  private readonly waiting = new Map<string, Set<() => void>>()

  /** A read of `hostKey` succeeded and returned `current`. */
  read(hostKey: string, current: KeyChange): void {
    this.hydrated.add(hostKey)
    this.known.set(hostKey, current)
    const waiters = this.waiting.get(hostKey)
    if (!waiters) return
    this.waiting.delete(hostKey)
    for (const start of waiters) start()
  }

  /** A read of `hostKey` failed: its stored value is unknown. */
  readFailed(hostKey: string): void {
    this.hydrated.delete(hostKey)
  }

  /** A write or delete of `next` is about to be sent. */
  sendStarted(hostKey: string, next: KeyChange): void {
    this.sending.set(hostKey, next)
  }

  /** The reply came: `stored` is what the host holds now, `null` when the write failed. */
  sendSettled(hostKey: string, stored: KeyChange | null): void {
    this.sending.delete(hostKey)
    if (stored) this.known.set(hostKey, stored)
  }

  /**
   * Watch `hostKey`: `listener` gets each remote change. The host watch starts
   * once the key was read (now, or when the first read succeeds), so its state
   * frame is newer than that read.
   */
  watch(
    hostKey: string,
    subscribe: WatchSubscribe,
    listener: (change: KeyChange) => void
  ): () => void {
    let stop: (() => void) | null = null
    let cancelled = false
    const start = (): void => {
      if (cancelled || stop) return
      stop = subscribe(hostKey, (change) => this.deliver(hostKey, change, listener))
    }
    let waiters: Set<() => void> | undefined
    if (this.hydrated.has(hostKey)) {
      start()
    } else {
      waiters = this.waiting.get(hostKey) ?? new Set()
      waiters.add(start)
      this.waiting.set(hostKey, waiters)
    }
    return () => {
      cancelled = true
      waiters?.delete(start)
      if (waiters?.size === 0 && this.waiting.get(hostKey) === waiters) this.waiting.delete(hostKey)
      stop?.()
      stop = null
    }
  }

  private deliver(hostKey: string, change: KeyChange, listener: (change: KeyChange) => void): void {
    if (!this.hydrated.has(hostKey)) return
    const echo =
      sameChange(this.known.get(hostKey), change) || sameChange(this.sending.get(hostKey), change)
    if (echo) return
    this.known.set(hostKey, change)
    listener(change)
  }
}
