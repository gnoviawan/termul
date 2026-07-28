/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PACKAGE_VERSION: string
  readonly VITE_TERMUL_UPDATE_MODE?: 'tauri' | 'aur'
  /** Set `true` by `vite.config.web.ts` for the browser/headless client build. */
  readonly TERMUL_WEB?: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
