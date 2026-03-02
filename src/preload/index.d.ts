import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  TerminalApi,
  ShellApi,
  PersistenceApi,
  DialogApi,
  SystemApi,
  KeyboardApi,
  ClipboardApi,
  FilesystemApi,
  WindowApi,
  VisibilityApi,
  SessionApi,
  SessionData
} from '@shared/types/ipc.types'
import type { UpdaterApi } from '@shared/types/updater.types'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      terminal: TerminalApi
      shell: ShellApi
      persistence: PersistenceApi
      dialog: DialogApi
      system: SystemApi
      keyboard: KeyboardApi
      updater: UpdaterApi
      clipboard: ClipboardApi
      filesystem: FilesystemApi
      window: WindowApi
      visibility: VisibilityApi
      session: SessionApi
      dataMigration: {
        runMigrations: () => Promise<{ success: true; data: { results: Array<{ version: string; success: boolean; error?: string; duration: number }> } } | { success: false; error: string; code: string }>
        rollback: (version: string) => Promise<{ success: true; data: void } | { success: false; error: string; code: string }>
        getHistory: () => Promise<{ success: true; data: Array<{ version: string; timestamp: string; success: boolean; error?: string; duration?: number }> } | { success: false; error: string; code: string }>
        getRegistered: () => Promise<{ success: true; data: Array<{ version: string; description: string; hasRollback: boolean }> } | { success: false; error: string; code: string }>
        getVersionInfo: () => Promise<{ success: true; data: { current: string; target: string } } | { success: false; error: string; code: string }>
      }
    }
  }
}
