import { useEffect, useRef } from 'react'

/**
 * Hook to track and broadcast document visibility state to the main process.
 * This allows main process services (CWD tracker, Git tracker) to pause/resume
 * polling when the app is not visible, reducing CPU usage during idle.
 */
export function useVisibilityState(): void {
  const isFirstRun = useRef(true)

  useEffect(() => {
    const broadcastVisibility = async (isVisible: boolean): Promise<void> => {
      try {
        await window.api.visibility.setVisibilityState(isVisible)
      } catch (error) {
        console.error('[Visibility] Failed to broadcast state:', error)
      }
    }

    const handleVisibilityChange = (): void => {
      const isVisible = document.visibilityState === 'visible'
      broadcastVisibility(isVisible)
    }

    // Broadcast initial state
    if (isFirstRun.current) {
      isFirstRun.current = false
      broadcastVisibility(document.visibilityState === 'visible')
    }

    // Listen for visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])
}
