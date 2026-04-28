/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PACKAGE_VERSION: string
  readonly VITE_TERMUL_UPDATE_MODE?: 'tauri' | 'aur'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
