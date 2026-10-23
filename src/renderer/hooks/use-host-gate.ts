import { useCallback, useSyncExternalStore } from 'react'
import { getAcpTransport } from '@/lib/acp-transport'

const noop = (): void => {}

/**
 * The value of a synchronous host-capability `gate` (such as
 * `claudeAccountsApi.canManageAccounts` or `canUseHostSsh`), re-read whenever
 * the connection's capabilities change: a web client learns them at the
 * `authenticate` handshake, after the first render.
 */
export function useHostGate(gate: () => boolean): boolean {
  const transport = getAcpTransport()
  const subscribe = useCallback(
    (onChange: () => void) => transport.subscribeCapabilities?.(onChange) ?? noop,
    [transport]
  )
  return useSyncExternalStore(subscribe, gate)
}
