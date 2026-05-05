/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PACKAGE_VERSION: string
  readonly VITE_TERMUL_UPDATE_MODE?: 'tauri' | 'aur'
  readonly VITE_XTERM_MIGRATION_CANARY?: 'off' | 'xterm-6.1' | 'true' | '1' | 'on'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
