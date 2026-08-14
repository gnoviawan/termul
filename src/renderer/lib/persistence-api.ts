/**
 * Persistence API Singleton
 *
 * Desktop (Tauri): `tauriPersistenceApi` — plugin-store file.
 * Web (termul-server): `webPersistenceApi` — server-side JSON store over the
 * authenticated WS protocol (issue #613), so web-client state survives browser
 * switches / refreshes instead of per-browser localStorage.
 */

import type { PersistenceApi } from '@shared/types/ipc.types'
import { createTauriPersistenceApi } from './tauri-persistence-api'
import { isTauriContext } from './tauri-runtime'
import { createWebPersistenceApi } from './web-persistence-api'

export const persistenceApi: PersistenceApi = isTauriContext()
  ? createTauriPersistenceApi()
  : createWebPersistenceApi()
