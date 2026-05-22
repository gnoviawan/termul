/**
 * Generic no-op mock for @tauri-apps/api/* sub-paths
 * Catches any remaining @tauri-apps/api/xxx imports not explicitly mocked.
 * Includes exports for: api/path, api/app, api/dpi, and other miscellaneous modules.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default {} as any

const noopStr = async (): Promise<string> => ''
const noopVoid = async (): Promise<void> => {}
const noopFalse = async (): Promise<boolean> => false
const noopNull = async (): Promise<null> => null
const noopNum = async (): Promise<number> => 0

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const invoke = async (_cmd: string, _args?: unknown): Promise<any> => {
  throw new Error(`[tauri-mock] invoke called in web context`)
}

export const listen = async (_event: string, _cb: unknown): Promise<() => void> => () => {}

export const emit = async (_event: string, _payload?: unknown): Promise<void> => {}

export class Channel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: ((r: any) => void) | null = null
  readonly id: number = Math.random()
}

// @tauri-apps/api/path
export const appDataDir = noopStr
export const appCacheDir = noopStr
export const appConfigDir = noopStr
export const appLocalDataDir = noopStr
export const appLogDir = noopStr
export const audioDir = noopStr
export const cacheDir = noopStr
export const configDir = noopStr
export const dataDir = noopStr
export const desktopDir = noopStr
export const documentDir = noopStr
export const downloadDir = noopStr
export const executableDir = noopStr
export const fontDir = noopStr
export const homeDir = noopStr
export const localDataDir = noopStr
export const pictureDir = noopStr
export const publicDir = noopStr
export const resourceDir = noopStr
export const runtimeDir = noopStr
export const templateDir = noopStr
export const videoDir = noopStr
export const resolve = async (..._parts: string[]): Promise<string> => ''
export const normalize = noopStr
export const join = async (..._parts: string[]): Promise<string> => ''
export const dirname = noopStr
export const extname = noopStr
export const basename = noopStr
export const isAbsolute = async (_path: string): Promise<boolean> => false
export const sep = '/'
export const delimiter = ':'

// @tauri-apps/api/app
export const getVersion = noopStr
export const getName = noopStr
export const getTauriVersion = noopStr
export const hide = noopVoid
export const show = noopVoid

// @tauri-apps/api/dpi / @tauri-apps/api/window sizing
export class LogicalPosition {
  constructor(public x: number, public y: number) {}
}
export class LogicalSize {
  constructor(public width: number, public height: number) {}
}
export class PhysicalPosition {
  constructor(public x: number, public y: number) {}
}
export class PhysicalSize {
  constructor(public width: number, public height: number) {}
}

// @tauri-apps/api/menu / @tauri-apps/api/tray
export const Menu = class {}
export const MenuItem = class {}
export const Submenu = class {}
export const TrayIcon = class {}

// Common getters that may be used in some contexts
export const getCurrentWindow = () => ({ label: 'main', listen: async () => () => {} })
export const getAll = (): unknown[] => []

// Generic catch-all for other exports
export const transformCallback = (_cb: unknown, _once?: boolean): number => 0
