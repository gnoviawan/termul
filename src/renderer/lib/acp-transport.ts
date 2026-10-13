/**
 * ACP transport abstraction — public facade.
 *
 * The implementation lives in the `acp-transport/` module directory:
 * `acp-transport/types.ts` holds the `AcpTransport` contract + error
 * surface, `acp-transport/event-names.ts` the `acp:*` ↔ WS-type
 * translation, `acp-transport/ws-transport.ts` the `/ws` protocol client,
 * `acp-transport/desktop-transport.ts` its Tauri IPC Channel subclass, and
 * `acp-transport/index.ts` the transport-selection factory + lazy singleton. This shim keeps every
 * existing `'@/lib/acp-transport'` / `'./acp-transport'` import site
 * resolving unchanged.
 */

export * from './acp-transport/index'
