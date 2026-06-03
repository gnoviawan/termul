/**
 * Persistence API Singleton
 */

import type { PersistenceApi } from '@shared/types/ipc.types'
import { createTauriPersistenceApi } from './tauri-persistence-api'

export const persistenceApi: PersistenceApi = createTauriPersistenceApi()
