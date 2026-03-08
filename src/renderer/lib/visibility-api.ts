/**
 * Visibility API Singleton
 */

import { createTauriVisibilityApi } from './tauri-visibility-api'
import type { VisibilityApi } from '@shared/types/ipc.types'

export const visibilityApi: VisibilityApi = createTauriVisibilityApi()
