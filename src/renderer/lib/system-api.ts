/**
 * System API Singleton
 */

import { createTauriSystemApi } from './tauri-system-api'
import type { SystemApi } from '@shared/types/ipc.types'

export const systemApi: SystemApi = createTauriSystemApi()
