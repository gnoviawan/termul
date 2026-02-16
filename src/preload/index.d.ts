import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  TerminalApi,
  ShellApi,
  PersistenceApi,
  DialogApi,
  SystemApi,
  KeyboardApi,
  ClipboardApi,
  FilesystemApi
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
    }
  }
}
