import { open, save, message, confirm } from '@tauri-apps/plugin-dialog';
import type { IpcResult } from '@shared/types/ipc.types';

export const tauriDialogApi = {
  async selectDirectory(): Promise<IpcResult<string | null>> {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Pilih Folder Project',
      });
      return { success: true, data: selected as string | null };
    } catch (err) {
      return { success: false, error: String(err), code: 'DIALOG_ERROR' };
    }
  },

  async selectFile(options?: { filters?: Array<{ name: string; extensions: string[] }> }): Promise<IpcResult<string | null>> {
    try {
      const selected = await open({
        multiple: false,
        filters: options?.filters,
      });
      return { success: true, data: selected as string | null };
    } catch (err) {
      return { success: false, error: String(err), code: 'DIALOG_ERROR' };
    }
  },

  async saveFile(options?: { filters?: Array<{ name: string; extensions: string[] }> }): Promise<IpcResult<string | null>> {
    try {
      const saved = await save({
        filters: options?.filters,
      });
      return { success: true, data: saved as string | null };
    } catch (err) {
      return { success: false, error: String(err), code: 'DIALOG_ERROR' };
    }
  },

  async confirmClose(message: string): Promise<boolean> {
    return await confirm(message, {
      title: 'Konfirmasi',
      kind: 'warning',
    });
  },

  async showMessage(msg: string, title = 'Info'): Promise<void> {
    await message(msg, {
      title,
    });
  },
};

/**
 * Factory function for consistency with other APIs
 */
export function createTauriDialogApi() {
  return tauriDialogApi;
}
