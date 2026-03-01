import { useEffect } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
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
    let restoreTimeout: ReturnType<typeof setTimeout>

    const restoreWindowState = async () => {
      try {
        const result = await persistenceApi.read<WindowState>(WINDOW_STATE_KEY)
        if (result.success && result.data) {
          const state = result.data
          const window = getCurrentWindow()

          // Use plain objects instead of LogicalPosition/LogicalSize
          await window.setPosition({ x: state.x, y: state.y })
          await window.setSize({ width: state.width, height: state.height })

          if (state.isMaximized) {
            await window.maximize()
          }
        }
      } catch (err) {
        console.error('Failed to restore window state:', err)
      }
    }

    // Delay restoration to ensure window is ready
    restoreTimeout = setTimeout(restoreWindowState, 100)

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
