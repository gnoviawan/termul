import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  TerminalApi,
  ShellApi,
  PersistenceApi,
  DialogApi,
  SystemApi,
  KeyboardApi
} from '@shared/types/ipc.types'

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
    }
  }
}
