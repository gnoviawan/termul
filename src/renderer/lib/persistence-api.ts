/**
 * Persistence API Singleton
 *
 * One facade on every surface: the host store, reached over the authenticated
 * `store_*` requests of the `/ws` protocol. Browsers and phones speak it over a
 * WebSocket; the desktop speaks it over the Tauri IPC Channel carrier
 * (`ChannelSocket`) to the host store it runs in-process, so every surface
 * scopes keys by device, tracks revisions and reports write failures the same
 * way. The desktop plugin-store file `termul-data.json` is no longer read or
 * written here: the host imports it once, into the first device that reaches
 * the store over the Channel.
 *
 * The store socket gets its own Channel connection, as the web store socket has
 * its own WebSocket: it connects on demand, keeps the 10 s handshake budget,
 * pings while idle so the host does not close it, and reconnects on the next
 * request if the host ends it anyway. Sharing the ACP transport's connection
 * would need a request path on the transport that only the desktop would use.
 */

import type { PersistenceApi } from '@shared/types/ipc.types'
import { ChannelSocket } from './acp-transport/channel-socket'
import { DESKTOP_CHANNEL_URL } from './acp-transport/desktop-transport'
import { isTauriContext } from './tauri-runtime'
import { createWebPersistenceApi } from './web-persistence-api'

/** Well inside the host's silent-peer limit (`PONG_TIMEOUT`, 75 s). */
const DESKTOP_KEEP_ALIVE_MS = 30_000

export const persistenceApi: PersistenceApi = createWebPersistenceApi(
  isTauriContext()
    ? {
        url: DESKTOP_CHANNEL_URL,
        // `ChannelSocket` implements the WebSocket surface the store socket uses.
        WebSocketImpl: ChannelSocket as unknown as typeof WebSocket,
        // The process boundary is the auth: the host waives the token here.
        authToken: () => null,
        // The Channel has no ping/pong: the host closes a connection that sends
        // no frame for 75 s, so an idle store connection pings inside that.
        keepAliveMs: DESKTOP_KEEP_ALIVE_MS
      }
    : undefined
)
