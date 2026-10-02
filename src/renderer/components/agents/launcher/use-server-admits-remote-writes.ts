import { useSyncExternalStore } from 'react'
import { getServerCapabilitySnapshot, subscribeServerCapability } from '@/lib/tauri-runtime'

/** React hook over the server write-admission capability cache so the
 * launcher re-renders when the boot `/health` fetch resolves (the cache flips
 * `false`→`true`). Desktop short-circuits to `true` via `primeServerCapability`
 * (no fetch fires, cache seeded admitted). */
export function useServerAdmitsRemoteWrites(): boolean {
  const { admitted } = useSyncExternalStore(
    subscribeServerCapability,
    getServerCapabilitySnapshot()
  )
  return admitted
}
