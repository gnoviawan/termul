import { invoke } from '@tauri-apps/api/core'
import type { UiLanguage } from '@/types/settings'
import { logFrontendError } from './log-api'
import { isTauriContext } from './tauri-runtime'

/** Keep native menus/tray labels in sync with the renderer language on desktop. */
export async function syncNativeUiLanguage(language: UiLanguage): Promise<void> {
  if (!isTauriContext()) return

  try {
    await invoke('set_native_ui_language', { language })
  } catch (error) {
    await logFrontendError({
      level: 'warn',
      source: 'native-ui-language',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}
