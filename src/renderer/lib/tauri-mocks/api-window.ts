/**
 * Mock for @tauri-apps/api/window
 * Used in web (non-Tauri) context to prevent import errors.
 */

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

const noop = async (): Promise<void> => {}
const noopFalse = async (): Promise<boolean> => false
const noopNull = async (): Promise<null> => null

const mockWindow = {
  label: 'main',
  listen: async () => () => {},
  once: async () => () => {},
  emit: noop,
  setTitle: noop,
  setSize: noop,
  setPosition: noop,
  center: noop,
  show: noop,
  hide: noop,
  close: noop,
  destroy: noop,
  minimize: noop,
  maximize: noop,
  unmaximize: noop,
  toggleMaximize: noop,
  setFullscreen: noop,
  isMaximized: noopFalse,
  isMinimized: noopFalse,
  isVisible: async () => true,
  isFullscreen: noopFalse,
  isDecorated: noopFalse,
  isResizable: async () => true,
  isFocused: noopFalse,
  scaleFactor: async () => 1,
  innerPosition: async () => new PhysicalPosition(0, 0),
  outerPosition: async () => new PhysicalPosition(0, 0),
  innerSize: async () => new PhysicalSize(window.innerWidth, window.innerHeight),
  outerSize: async () => new PhysicalSize(window.outerWidth, window.outerHeight),
  startDragging: noop,
  startResizeDragging: noop,
  setAlwaysOnTop: noop,
  setAlwaysOnBottom: noop,
  setContentProtected: noop,
  setDecorations: noop,
  setResizable: noop,
  setMinimizable: noop,
  setMaximizable: noop,
  setClosable: noop,
  setMinSize: noop,
  setMaxSize: noop,
  setSkipTaskbar: noop,
  setIcon: noop,
  setProgressBar: noop,
  setVisibleOnAllWorkspaces: noop,
  requestUserAttention: noop,
  setFocus: noop,
  onCloseRequested: () => () => {},
  onResized: () => () => {},
  onMoved: () => () => {},
  onFocusChanged: () => () => {},
  onScaleFactorChanged: () => () => {},
  onThemeChanged: () => () => {},
  onFileDropEvent: () => () => {},
  onMenuClicked: () => () => {},
  theme: noopNull,
}

export function getCurrentWindow() {
  return mockWindow
}

export function getCurrent() {
  return mockWindow
}

export function getAll() {
  return [mockWindow]
}

export class Window {
  label: string
  constructor(label: string) {
    this.label = label
    return Object.assign(this, mockWindow)
  }
}
