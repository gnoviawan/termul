import { useEffect, useRef } from 'react'
import { visibilityApi } from '@/lib/visibility-api'

/**
 * Hook to track document visibility state.
 * Uses the native DOM API for visibility state detection.
 * Broadcasts visibility changes to backend for tracker polling optimization.
 */
export function useVisibilityState(): void {
  const isFirstRun = useRef(true)
  const isBroadcastingRef = useRef(false)

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      const isVisible = document.visibilityState === 'visible'
      console.debug('[Visibility] App visibility changed:', isVisible)

      // Broadcast to backend for visibility-aware polling
      // Use fire-and-forget pattern - don't await to avoid blocking UI
      if (!isBroadcastingRef.current) {
        isBroadcastingRef.current = true
        visibilityApi.setVisibilityState(isVisible).finally(() => {
          isBroadcastingRef.current = false
        })
      }
    }

    // Log initial state and broadcast to backend
    if (isFirstRun.current) {
      isFirstRun.current = false
      const initialIsVisible = document.visibilityState === 'visible'
      console.debug('[Visibility] Initial state:', initialIsVisible)

      // Broadcast initial state to backend
      visibilityApi.setVisibilityState(initialIsVisible).catch((err) => {
        console.warn('[Visibility] Failed to broadcast initial state:', err)
      })
    }

    // Listen for visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])
}
