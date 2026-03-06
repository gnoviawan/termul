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

function createDefaultWindowState(monitor: Monitor | null): WindowState {
  const workArea = monitor?.workArea

  const originX = workArea?.position.x ?? 0
  const originY = workArea?.position.y ?? 0
  const workWidth = workArea?.size.width ?? DEFAULT_WIDTH
  const workHeight = workArea?.size.height ?? DEFAULT_HEIGHT

  return {
    x: Math.round(originX + (workWidth - DEFAULT_WIDTH) / 2),
    y: Math.round(originY + (workHeight - DEFAULT_HEIGHT) / 2),
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    isMaximized: false
  }
}

async function getDefaultWindowState(): Promise<WindowState> {
  const monitor = await primaryMonitor()
  return createDefaultWindowState(monitor)
}

function isPositionOnScreen(state: WindowState, monitors: Monitor[]): boolean {
  if (monitors.length === 0) return true

  return monitors.some((monitor) => {
    const area = monitor.workArea
    const dx = area.position.x
    const dy = area.position.y
    const dw = area.size.width
    const dh = area.size.height

    const overlapX = Math.max(0, Math.min(state.x + state.width, dx + dw) - Math.max(state.x, dx))
    const overlapY = Math.max(0, Math.min(state.y + state.height, dy + dh) - Math.max(state.y, dy))

    return overlapX >= MIN_VISIBLE_PIXELS && overlapY >= MIN_VISIBLE_PIXELS
  })
}

async function loadWindowState(): Promise<WindowState> {
  const result = await persistenceApi.read<WindowState>(PersistenceKeys.windowState)

  if (!result.success || !result.data) {
    return getDefaultWindowState()
  }

  const persistedState = result.data
  const monitors = await availableMonitors()

  if (isPositionOnScreen(persistedState, monitors)) {
    return persistedState
  }

  const defaultState = await getDefaultWindowState()
  return {
    ...defaultState,
    width: persistedState.width,
    height: persistedState.height,
    isMaximized: persistedState.isMaximized
  }
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

      const position = await window.outerPosition()
      const size = await window.outerSize()
      const state: WindowState = {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
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
