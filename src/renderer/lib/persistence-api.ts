/**
 * Persistence API Singleton
 */

import { createTauriPersistenceApi } from './tauri-persistence-api'
import type { PersistenceApi } from '@shared/types/ipc.types'

export const persistenceApi: PersistenceApi = createTauriPersistenceApi()
