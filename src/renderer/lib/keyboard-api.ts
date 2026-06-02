/**
 * Keyboard API Singleton
 */

import type { KeyboardApi } from '@shared/types/ipc.types'
import { createTauriKeyboardApi } from './tauri-keyboard-api'

export const keyboardApi: KeyboardApi = createTauriKeyboardApi()
