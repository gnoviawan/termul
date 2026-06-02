/**
 * Window API Singleton
 */

import type { WindowApi } from '@shared/types/ipc.types'
import { createTauriWindowApi } from './tauri-window-api'

export const windowApi: WindowApi = createTauriWindowApi()
