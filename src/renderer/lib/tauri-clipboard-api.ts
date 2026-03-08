import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import type { IpcResult } from '@shared/types/ipc.types';

const MAX_CLIPBOARD_SIZE = 10 * 1024 * 1024; // 10MB

export const tauriClipboardApi = {
  async readText(): Promise<IpcResult<string>> {
    try {
      const text = await readText();
      return { success: true, data: text };
    } catch (err) {
      return { success: false, error: String(err), code: 'READ_ERROR' };
    }
  },

  async writeText(text: string): Promise<IpcResult<void>> {
    try {
      const size = new Blob([text]).size;
      if (size > MAX_CLIPBOARD_SIZE) {
        return {
          success: false,
          error: `Text too large (${size} bytes, max ${MAX_CLIPBOARD_SIZE})`,
          code: 'CLIPBOARD_TOO_LARGE'
        };
      }
      await writeText(text);
      return { success: true, data: undefined };
    } catch (err) {
      return { success: false, error: String(err), code: 'WRITE_ERROR' };
    }
  },
};
