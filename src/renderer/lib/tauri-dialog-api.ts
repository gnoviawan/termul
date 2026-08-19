import type { IpcResult } from '@shared/types/ipc.types'
import { confirm, message, open, save } from '@tauri-apps/plugin-dialog'
import { runtimeT } from '@/i18n/runtime'

export const tauriDialogApi = {
  async selectDirectory(): Promise<IpcResult<string | null>> {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: runtimeT('common', 'dialog.selectProjectFolder', 'Select Project Folder')
      })
      return { success: true, data: selected as string | null }
    } catch (err) {
      return { success: false, error: String(err), code: 'DIALOG_ERROR' }
    }
  },

  async selectFile(options?: {
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<IpcResult<string | null>> {
    try {
      const selected = await open({
        multiple: false,
        filters: options?.filters,
        title: runtimeT('common', 'dialog.selectFile', 'Select File')
      })
      return { success: true, data: selected as string | null }
    } catch (err) {
      return { success: false, error: String(err), code: 'DIALOG_ERROR' }
    }
  },

  async saveFile(options?: {
    filters?: Array<{ name: string; extensions: string[] }>
  }): Promise<IpcResult<string | null>> {
    try {
      const saved = await save({
        filters: options?.filters,
        title: runtimeT('common', 'dialog.saveFile', 'Save File')
      })
      return { success: true, data: saved as string | null }
    } catch (err) {
      return { success: false, error: String(err), code: 'DIALOG_ERROR' }
    }
  },

  async confirmClose(message: string): Promise<boolean> {
    return await confirm(message, {
      title: runtimeT('common', 'dialog.confirm', 'Confirm'),
      kind: 'warning'
    })
  },

  async showMessage(msg: string, title?: string): Promise<void> {
    await message(msg, {
      title: title ?? runtimeT('common', 'dialog.info', 'Info')
    })
  }
}

/**
 * Factory function for consistency with other APIs
 */
export function createTauriDialogApi() {
  return tauriDialogApi
}
