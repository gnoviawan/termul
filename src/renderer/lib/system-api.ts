/**
 * System API Singleton
 */

import type { SystemApi } from '@shared/types/ipc.types'
import { createTauriSystemApi } from './tauri-system-api'

export const systemApi: SystemApi = createTauriSystemApi()
