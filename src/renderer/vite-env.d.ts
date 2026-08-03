/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PACKAGE_VERSION: string
  readonly VITE_TERMUL_UPDATE_MODE?: 'tauri' | 'aur'
  /** Set `true` by `vite.config.web.ts` for the browser/headless client build. */
  readonly TERMUL_WEB?: boolean
  /**
   * Build-time app version (CAP-3). Injected by `vite.config.web.ts`
   * `define` from `package.json#version` so `getCurrentAppVersion()` can
   * return the running version on the web client (desktop uses Tauri's
   * `getVersion`). Falls back to `'0.0.0'` at runtime when undefined
   * (e.g. under Vitest, where the define is not applied).
   */
  readonly VITE_APP_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
