/**
 * Keyboard API Singleton
 */

import { createTauriKeyboardApi } from './tauri-keyboard-api'
import type { KeyboardApi } from '@shared/types/ipc.types'

export const keyboardApi: KeyboardApi = createTauriKeyboardApi()
