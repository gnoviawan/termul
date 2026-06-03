/**
 * Visibility API Singleton
 */

import type { VisibilityApi } from '@shared/types/ipc.types'
import { createTauriVisibilityApi } from './tauri-visibility-api'

export const visibilityApi: VisibilityApi = createTauriVisibilityApi()
