/** Parity size: the harness shoots both clients at it. */
export const WINDOW_WIDTH = 1280
export const WINDOW_HEIGHT = 800

/** The desktop app's main window (`src-tauri/tauri.conf.json`). */
export const DESKTOP_WINDOW = {
  title: 'Termul Manager',
  /** X11 `WM_CLASS` / Wayland `app_id`; the Linux package's .desktop `StartupWMClass` matches it. */
  appId: 'com.termul-manager.gpuix',
  width: 1200,
  height: 800,
  minWidth: 800,
  minHeight: 600
} as const

export interface WindowSize {
  width: number
  height: number
}
