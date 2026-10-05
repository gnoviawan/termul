/**
 * ACP transport abstraction (Story 1.6).
 *
 * Desktop: Tauri `invoke` / `listen`.
 * Web: multiplexed `/ws` client — request/reply by `id`, events with `seq`
 * dedup + gap-fill, cursor reconnect via `subscribe`, reliability tiers from
 * `@shared/types/web-protocol.types`.
 *
 * Envelope fields are snake_case; payloads stay camelCase (Story 1.4 AC3).
 * Event names: store uses `acp:*`; WS uses prefix-dropped types — translated here.
 *
 * Error bridge: WS `{ok:false,err:{code,message}}` throws `AcpTransportError`
 * (`.message` is the human string callers already toast).
 *
 * Module layout: `./types` holds the transport contract + error surface,
 * `./event-names` the `acp:*` ↔ WS-type translation, `./tauri-transport` the
 * desktop `invoke`/`listen` implementation, `./ws-transport` the web/server
 * WebSocket client, and this file the transport-selection factory + lazy
 * singleton. The `@/lib/acp-transport` facade re-exports this surface.
 */

import { isTauriContext } from '@/lib/tauri-runtime'
import { createTauriAcpTransport } from './tauri-transport'
import type { AcpTransport } from './types'
import { WsAcpTransport } from './ws-transport'

export { toTauriEventName, toWsEventType } from './event-names'
export { _resetTauriEventRegistryForTests } from './tauri-transport'
export {
  type AcpConnectionState,
  type AcpTransport,
  AcpTransportError,
  isTransientAcpTransportError
} from './types'
export { resolveWsUrl, WsAcpTransport } from './ws-transport'

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let singleton: AcpTransport | null = null

/** Create (or return) the process-wide ACP transport. */
export function createAcpTransport(opts?: {
  force?: 'tauri' | 'ws'
  ws?: { url?: string; WebSocketImpl?: typeof WebSocket }
}): AcpTransport {
  if (opts?.force === 'tauri') return createTauriAcpTransport()
  if (opts?.force === 'ws') return new WsAcpTransport(opts.ws)
  if (isTauriContext()) return createTauriAcpTransport()
  return new WsAcpTransport(opts?.ws)
}

/** Lazy singleton used by `acp-api.ts`. Resettable in tests via `_resetAcpTransportForTests`. */
export function getAcpTransport(): AcpTransport {
  if (!singleton) singleton = createAcpTransport()
  return singleton
}

/** @internal test helper */
export function _resetAcpTransportForTests(next?: AcpTransport | null): void {
  singleton?.dispose()
  singleton = next ?? null
}

/** @internal test helper — inject a pre-built transport as the singleton. */
export function _setAcpTransportForTests(transport: AcpTransport): void {
  singleton?.dispose()
  singleton = transport
}
