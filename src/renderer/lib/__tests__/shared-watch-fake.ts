/**
 * A stand-in for the persistence facade of a page whose shared keys other
 * devices change: `remote` is what the host watch reports after a write by
 * another device.
 */

import type { PersistenceKeyChange } from '@shared/types/ipc.types'
import { vi } from 'vitest'

type Listener = (change: PersistenceKeyChange) => void

const stored = new Map<string, unknown>()
const listeners = new Map<string, Set<Listener>>()

export const sharedFake = {
  api: {
    read: vi.fn(async (key: string) =>
      stored.has(key)
        ? { success: true as const, data: stored.get(key) }
        : { success: false as const, error: 'Key not found', code: 'KEY_NOT_FOUND' }
    ),
    write: vi.fn(async () => ({ success: true as const, data: undefined })),
    writeDebounced: vi.fn(async () => ({ success: true as const, data: undefined })),
    delete: vi.fn(async () => ({ success: true as const, data: undefined })),
    watchShared: vi.fn((key: string, listener: Listener) => {
      const set = listeners.get(key) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(key, set)
      return () => {
        set.delete(listener)
      }
    })
  },
  /** Seed the host value of `key` that this page reads. */
  seed(key: string, data: unknown): void {
    stored.set(key, data)
  },
  /** Another device saved `data` under `key`. */
  remote(key: string, data: unknown): void {
    stored.set(key, data)
    for (const listener of Array.from(listeners.get(key) ?? [])) listener({ exists: true, data })
  },
  /** Another device deleted `key`. */
  remoteDelete(key: string): void {
    stored.delete(key)
    for (const listener of Array.from(listeners.get(key) ?? [])) listener({ exists: false })
  },
  watcherCount(key: string): number {
    return listeners.get(key)?.size ?? 0
  },
  /** Forget stored values; `keepWatchers` for owners that watch once per page lifetime. */
  reset(keepWatchers = false): void {
    stored.clear()
    if (!keepWatchers) listeners.clear()
    sharedFake.api.read.mockClear()
    sharedFake.api.write.mockClear()
    sharedFake.api.writeDebounced.mockClear()
    sharedFake.api.delete.mockClear()
    sharedFake.api.watchShared.mockClear()
  }
}
