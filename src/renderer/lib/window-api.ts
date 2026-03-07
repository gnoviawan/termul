/**
 * Window API Singleton
 */

import { createTauriWindowApi } from './tauri-window-api'
import type { WindowApi } from '@shared/types/ipc.types'

export const windowApi: WindowApi = createTauriWindowApi()
