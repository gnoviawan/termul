import { useEffect, useRef } from 'react'

/**
 * Hook to track document visibility state.
 * Uses the native DOM API for visibility state detection.
 * In Tauri, visibility state is handled directly via the document API.
 */
export function useVisibilityState(): void {
  const isFirstRun = useRef(true)

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      const isVisible = document.visibilityState === 'visible'
      // Visibility state is available via document.visibilityState
      // No need to broadcast to main process in Tauri
      console.debug('[Visibility] App visibility changed:', isVisible)
    }

    // Log initial state
    if (isFirstRun.current) {
      isFirstRun.current = false
      console.debug('[Visibility] Initial state:', document.visibilityState === 'visible')
    }

    // Listen for visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])
}
