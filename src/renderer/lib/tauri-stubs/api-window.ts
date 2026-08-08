import { tauriUnavailable } from './unavailable'

export class LogicalPosition {
  constructor(
    public x: number,
    public y: number
  ) {}
}

export class LogicalSize {
  constructor(
    public width: number,
    public height: number
  ) {}
}

export type Monitor = {
  name: string | null
  size: { width: number; height: number }
  position: { x: number; y: number }
  workArea: {
    size: { width: number; height: number }
    position: { x: number; y: number }
  }
  scaleFactor: number
}

function createWindowStub() {
  return {
    show: () => tauriUnavailable('window.show'),
    minimize: () => tauriUnavailable('window.minimize'),
    maximize: () => tauriUnavailable('window.maximize'),
    unmaximize: () => tauriUnavailable('window.unmaximize'),
    toggleMaximize: () => tauriUnavailable('window.toggleMaximize'),
    close: () => tauriUnavailable('window.close'),
    destroy: () => tauriUnavailable('window.destroy'),
    isMaximized: async () => false,
    isMinimized: async () => false,
    isFullscreen: async () => false,
    isVisible: async () => true,
    setPosition: () => tauriUnavailable('window.setPosition'),
    setSize: () => tauriUnavailable('window.setSize'),
    outerPosition: async () => ({ x: 0, y: 0 }),
    outerSize: async () => ({ width: 1200, height: 800 }),
    innerPosition: async () => ({ x: 0, y: 0 }),
    innerSize: async () => ({ width: 1200, height: 800 }),
    startResizeDragging: () => tauriUnavailable('window.startResizeDragging'),
    startDragging: () => tauriUnavailable('window.startDragging'),
    setFocus: () => tauriUnavailable('window.setFocus'),
    onFocusChanged: async () => () => {},
    onResized: async () => () => {},
    onMoved: async () => () => {},
    onScaleFactorChanged: async () => () => {}
  }
}

export function getCurrentWindow() {
  return createWindowStub()
}

export async function availableMonitors(): Promise<Monitor[]> {
  return []
}

export async function primaryMonitor(): Promise<Monitor | null> {
  return null
}

export async function currentMonitor(): Promise<Monitor | null> {
  return null
}
