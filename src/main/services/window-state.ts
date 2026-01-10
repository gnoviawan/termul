import { screen, BrowserWindow } from 'electron'
import type { WindowState } from '../../shared/types/persistence.types'
import { PersistenceKeys } from '../../shared/types/persistence.types'
import { read, writeDebounced, write } from './persistence-service'

// Default window dimensions
const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 800

/**
 * Default window state used when no persisted state exists
 * or when saved position is off-screen
 */
export function getDefaultWindowState(): WindowState {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

  return {
    x: Math.round((screenWidth - DEFAULT_WIDTH) / 2),
    y: Math.round((screenHeight - DEFAULT_HEIGHT) / 2),
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    isMaximized: false
  }
}

/**
 * Check if a rectangle is visible on any available display
 * Returns true if at least 100 pixels of the window would be visible
 */
export function isPositionOnScreen(state: WindowState): boolean {
  const displays = screen.getAllDisplays()
  const minVisiblePixels = 100

  for (const display of displays) {
    const { x: dx, y: dy, width: dw, height: dh } = display.bounds

    // Calculate overlap between window and display
    const overlapX = Math.max(0, Math.min(state.x + state.width, dx + dw) - Math.max(state.x, dx))
    const overlapY = Math.max(0, Math.min(state.y + state.height, dy + dh) - Math.max(state.y, dy))

    // Check if enough of the window is visible on this display
    if (overlapX >= minVisiblePixels && overlapY >= minVisiblePixels) {
      return true
    }
  }

  return false
}

/**
 * Load persisted window state from disk
 * Returns default state if no persisted state exists or position is off-screen
 */
export async function loadWindowState(): Promise<WindowState> {
  const result = await read<WindowState>(PersistenceKeys.windowState)

  if (result.success && result.data) {
    const state = result.data

    // Validate that the position is still on a visible screen
    if (isPositionOnScreen(state)) {
      return state
    }

    // Position is off-screen, use default but preserve size and maximized state
    const defaultState = getDefaultWindowState()
    return {
      ...defaultState,
      width: state.width,
      height: state.height,
      isMaximized: state.isMaximized
    }
  }

  return getDefaultWindowState()
}

/**
 * Save window state with debouncing
 * Called on window move/resize events
 */
export function saveWindowStateDebounced(window: BrowserWindow): void {
  // When maximized, only save the maximized flag - don't update bounds
  // This preserves the normal (unmaximized) window dimensions
  if (window.isMaximized()) {
    // Read current persisted state to preserve pre-maximized bounds
    read<WindowState>(PersistenceKeys.windowState)
      .then((result) => {
        const existingBounds =
          result.success && result.data
            ? {
                x: result.data.x,
                y: result.data.y,
                width: result.data.width,
                height: result.data.height
              }
            : getDefaultWindowState()

        const state: WindowState = {
          ...existingBounds,
          isMaximized: true
        }
        writeDebounced(PersistenceKeys.windowState, state)
      })
      .catch((err) => {
        console.error('Failed to save maximized window state:', err)
      })
    return
  }

  const bounds = window.getBounds()
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: false
  }

  writeDebounced(PersistenceKeys.windowState, state)
}

/**
 * Save window state immediately (for app quit)
 */
export async function saveWindowStateSync(window: BrowserWindow): Promise<void> {
  const bounds = window.getBounds()
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: window.isMaximized()
  }

  await write(PersistenceKeys.windowState, state)
}

/**
 * Set up window state tracking listeners
 * Attaches to move and resize events with debounced saves
 */
export function trackWindowState(window: BrowserWindow): void {
  const handleStateChange = (): void => {
    saveWindowStateDebounced(window)
  }

  window.on('move', handleStateChange)
  window.on('resize', handleStateChange)
}
