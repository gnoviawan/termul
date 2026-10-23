/** Parity size: the harness shoots both clients at it. */
export const WINDOW_WIDTH = 1280
export const WINDOW_HEIGHT = 800

/** The desktop app's main window (`src-tauri/tauri.conf.json`). */
export const DESKTOP_WINDOW = {
  title: 'Termul Manager',
  width: 1200,
  height: 800,
  minWidth: 800,
  minHeight: 600
} as const

export interface WindowSize {
  width: number
  height: number
}
