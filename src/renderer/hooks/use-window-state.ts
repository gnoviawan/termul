import { useEffect } from 'react'
import { getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window'
import { persistenceApi } from '@/lib/api'

interface WindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
}

const WINDOW_STATE_KEY = 'window-state'

export function useWindowState() {
  useEffect(() => {
    const restoreWindowState = async () => {
      try {
        const result = await persistenceApi.read<WindowState>(WINDOW_STATE_KEY)
        if (result.success && result.data) {
          const state = result.data
          const window = getCurrentWindow()

          await window.setPosition(new LogicalPosition(state.x, state.y))
          await window.setSize(new LogicalSize(state.width, state.height))

          if (state.isMaximized) {
            await window.maximize()
          }
        }
      } catch (err) {
        console.error('Failed to restore window state:', err)
      }
    }

    // Delay restoration to ensure window is ready
    const restoreTimeout = setTimeout(restoreWindowState, 100)

    return () => clearTimeout(restoreTimeout)
  }, [])

  const saveWindowState = async () => {
    try {
      const window = getCurrentWindow()
      const pos = await window.outerPosition()
      const size = await window.outerSize()
      const maximized = await window.isMaximized()

      const state: WindowState = {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        isMaximized: maximized,
      }

      await persistenceApi.write(WINDOW_STATE_KEY, state)
    } catch (err) {
      console.error('Failed to save window state:', err)
    }
  }

  return { saveWindowState }
}
