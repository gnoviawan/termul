/**
 * Keeps in-memory state in step with a shared store key that another device or
 * tab changes.
 *
 * `apply` gets what the key holds after each remote change. It must only
 * update in-memory state: this helper never writes, and the persistence facade
 * does not report the echo of this page's own writes, so an applied value
 * cannot ping-pong between devices. Nothing is reported before the key was
 * read once, and the host sends the full state again after a reconnect.
 */

import type { PersistenceKeyChange } from '@shared/types/ipc.types'
import { useEffect, useRef } from 'react'
import { persistenceApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'

export type SharedKeyChange<T> = PersistenceKeyChange<T>

/** Apply remote changes of `key` until the returned function is called. */
export function syncSharedKey<T>(
  key: string,
  apply: (change: SharedKeyChange<T>) => void
): () => void {
  const stop = persistenceApi.watchShared?.(key, (change) => {
    try {
      apply(change as SharedKeyChange<T>)
    } catch (err) {
      void logFrontendError({
        level: 'warn',
        source: 'shared-key-sync',
        message: `applying a remote change of ${key} failed: ${String(err)}`
      })
    }
  })
  return stop ?? (() => undefined)
}

/** `syncSharedKey` for the lifetime of the calling component. */
export function useSharedKeySync<T>(
  key: string,
  apply: (change: SharedKeyChange<T>) => void
): void {
  const applyRef = useRef(apply)
  useEffect(() => {
    applyRef.current = apply
  })
  useEffect(() => syncSharedKey<T>(key, (change) => applyRef.current(change)), [key])
}
