import { useEffect, useRef, useState } from 'react'
import {
  availableMonitors,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
  primaryMonitor,
  type Monitor
} from '@tauri-apps/api/window'
import { persistenceApi } from '@/lib/api'
import { cleanupTauriListener, isTauriContext } from '@/lib/tauri-runtime'
import { PersistenceKeys, type WindowState } from '@shared/types/persistence.types'

const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 800
const MIN_VISIBLE_PIXELS = 100

interface LogicalRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Tauri reports window geometry (`outerPosition`/`outerSize`) and monitor work
 * areas in *physical* pixels, but `setPosition`/`setSize` here apply *logical*
 * pixels. On HiDPI displays the two differ by the monitor scale factor, so we
 * normalize everything to logical pixels. Persisting and restoring in the same
 * unit keeps the window where the user left it instead of drifting off-screen
 * (e.g. after sleep/wake when the active monitor or its scale factor changes).
 */
function normalizeScaleFactor(scaleFactor: number | undefined): number {
  return typeof scaleFactor === 'number' && scaleFactor > 0 ? scaleFactor : 1
}

/** Convert a monitor's physical work area into logical coordinates. */
export function getLogicalWorkArea(monitor: Monitor | null): LogicalRect {
  if (!monitor?.workArea) {
    return { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  }

  const scale = normalizeScaleFactor(monitor.scaleFactor)
  const { position, size } = monitor.workArea

  return {
    x: Math.round(position.x / scale),
    y: Math.round(position.y / scale),
    width: Math.round(size.width / scale),
    height: Math.round(size.height / scale)
  }
}

function createDefaultWindowState(monitor: Monitor | null): WindowState {
  const area = getLogicalWorkArea(monitor)
  const width = Math.min(DEFAULT_WIDTH, area.width)
  const height = Math.min(DEFAULT_HEIGHT, area.height)

  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    isMaximized: false
  }
}

async function getDefaultWindowState(): Promise<WindowState> {
  const monitor = await primaryMonitor()
  return createDefaultWindowState(monitor)
}

function overlapArea(state: WindowState, area: LogicalRect): { x: number; y: number } {
  const overlapX = Math.max(
    0,
    Math.min(state.x + state.width, area.x + area.width) - Math.max(state.x, area.x)
  )
  const overlapY = Math.max(
    0,
    Math.min(state.y + state.height, area.y + area.height) - Math.max(state.y, area.y)
  )

  return { x: overlapX, y: overlapY }
}

export function isPositionOnScreen(state: WindowState, monitors: Monitor[]): boolean {
  if (monitors.length === 0) return true

  return monitors.some((monitor) => {
    const area = getLogicalWorkArea(monitor)
    const { x: overlapX, y: overlapY } = overlapArea(state, area)
    return overlapX >= MIN_VISIBLE_PIXELS && overlapY >= MIN_VISIBLE_PIXELS
  })
}

/**
 * Guarantee the restored window fits within, and sits fully inside, the monitor
 * it overlaps most. This protects against corrupt or stale persisted geometry
 * (the root cause of the window opening off-screen with an unreachable maximize
 * control). The window is never sized larger than the target work area and is
 * nudged back on-screen when its origin falls outside the visible bounds.
 */
export function clampStateToMonitors(state: WindowState, monitors: Monitor[]): WindowState {
  if (monitors.length === 0) return state

  let target = getLogicalWorkArea(monitors[0])
  let bestOverlap = -1

  for (const monitor of monitors) {
    const area = getLogicalWorkArea(monitor)
    const { x: overlapX, y: overlapY } = overlapArea(state, area)
    const overlap = overlapX * overlapY

    if (overlap > bestOverlap) {
      bestOverlap = overlap
      target = area
    }
  }

  const width = Math.min(state.width, target.width)
  const height = Math.min(state.height, target.height)
  const maxX = target.x + target.width - width
  const maxY = target.y + target.height - height
  const x = Math.min(Math.max(state.x, target.x), maxX)
  const y = Math.min(Math.max(state.y, target.y), maxY)

  return { ...state, x, y, width, height }
}

async function loadWindowState(): Promise<WindowState> {
  const result = await persistenceApi.read<WindowState>(PersistenceKeys.windowState)
  const monitors = await availableMonitors()

  if (!result.success || !result.data) {
    return clampStateToMonitors(await getDefaultWindowState(), monitors)
  }

  const persistedState = result.data

  if (isPositionOnScreen(persistedState, monitors)) {
    return clampStateToMonitors(persistedState, monitors)
  }

  // Persisted position is no longer visible (monitor removed, resolution or
  // scale changed). Recenter on the primary monitor but keep the saved size.
  const defaultState = await getDefaultWindowState()
  return clampStateToMonitors(
    {
      ...defaultState,
      width: persistedState.width,
      height: persistedState.height,
      isMaximized: persistedState.isMaximized
    },
    monitors
  )
}

export function useWindowState(): boolean {
  const [isReady, setIsReady] = useState(false)
  const normalStateRef = useRef<WindowState | null>(null)

  useEffect(() => {
    if (!isTauriContext()) {
      setIsReady(true)
      return
    }

    const window = getCurrentWindow()
    let disposed = false

    const buildWindowState = async (): Promise<WindowState> => {
      const isMaximized = await window.isMaximized()

      if (isMaximized) {
        const fallbackState = normalStateRef.current ?? (await getDefaultWindowState())
        return {
          ...fallbackState,
          isMaximized: true
        }
      }

      const scale = normalizeScaleFactor(await window.scaleFactor())
      const position = await window.outerPosition()
      const size = await window.outerSize()
      const state: WindowState = {
        x: Math.round(position.x / scale),
        y: Math.round(position.y / scale),
        width: Math.round(size.width / scale),
        height: Math.round(size.height / scale),
        isMaximized: false
      }

      normalStateRef.current = state
      return state
    }

    const persistWindowState = async (immediate = false): Promise<void> => {
      const state = await buildWindowState()
      const operation = immediate
        ? persistenceApi.write(PersistenceKeys.windowState, state)
        : persistenceApi.writeDebounced(PersistenceKeys.windowState, state)
      await operation
    }

    const initialize = async (): Promise<Array<() => void>> => {
      const restoredState = await loadWindowState()

      normalStateRef.current = {
        ...restoredState,
        isMaximized: false
      }

      await window.setPosition(new LogicalPosition(restoredState.x, restoredState.y))
      await window.setSize(new LogicalSize(restoredState.width, restoredState.height))

      if (restoredState.isMaximized) {
        await window.maximize()
      }

      const movedUnlisten = window.onMoved(() => void persistWindowState())
      const resizedUnlisten = window.onResized(() => void persistWindowState())
      const closeRequestedUnlisten = window.onCloseRequested(() => void persistWindowState(true))

      const cleanups = [
        () => cleanupTauriListener(movedUnlisten),
        () => cleanupTauriListener(resizedUnlisten),
        () => cleanupTauriListener(closeRequestedUnlisten)
      ]

      return cleanups
    }

    let cleanups: Array<() => void> = []

    void initialize()
      .then((listeners) => {
        if (disposed) {
          listeners.forEach((cleanup) => cleanup())
          return
        }

        cleanups = listeners
      })
      .catch((error) => {
        console.error('Failed to initialize window state:', error)
      })
      .finally(() => {
        if (!disposed) {
          setIsReady(true)
        }
      })

    return () => {
      disposed = true
      void persistWindowState(true)
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [])

  return isReady
}
