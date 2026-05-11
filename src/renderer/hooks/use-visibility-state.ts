import { useEffect, useRef } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { visibilityApi } from '@/lib/visibility-api'
import {
  HIDDEN_BUFFER_TRUNCATION_DELAY,
  useTerminalStore
} from '@/stores/terminal-store'
import { cleanupTauriListener, isTauriContext } from '@/lib/tauri-runtime'

function debugLogMemoryStats(): void {
  if (!import.meta.env.DEV) return

  const store = useTerminalStore.getState()
  const terminals = store.terminals
  if (!terminals || terminals.length === 0) return

  let totalTranscriptChars = 0
  let totalDetachedChars = 0
  let totalScrollbackLines = 0

  for (const t of terminals) {
    totalTranscriptChars += t.transcript?.length ?? 0
    totalDetachedChars += t.detachedOutput?.length ?? 0
    totalScrollbackLines += t.pendingScrollback?.length ?? 0
  }

  console.debug(
    `[MemTrack] terminals=${terminals.length} ` +
    `transcript=${(totalTranscriptChars / 1024).toFixed(0)}KB ` +
    `detachedOutput=${(totalDetachedChars / 1024).toFixed(0)}KB ` +
    `scrollbackLines=${totalScrollbackLines}`
  )
}

function applyAppHiddenState(isVisible: boolean): void {
  const store = useTerminalStore.getState()
  store.setAppHidden(!isVisible)

  if (import.meta.env.DEV) {
    console.debug(
      `[Visibility] App ${isVisible ? 'visible' : 'hidden'} — logging memory stats before transition`
    )
    debugLogMemoryStats()
  }

  // NOTE: Do NOT call truncateHiddenTerminalBuffers() here — the
  // eligibility check requires appHiddenSince to be older than
  // HIDDEN_BUFFER_TRUNCATION_DELAY, so an immediate call is always
  // a no-op. Actual truncation happens in scheduleHiddenMaintenance().
}

/**
 * Hook to track app visibility state.
 * Uses DOM visibility and a Tauri window-state fallback for desktop minimize behavior.
 * Broadcasts visibility changes to backend for tracker polling optimization.
 */
export function useVisibilityState(): void {
  const isFirstRun = useRef(true)
  const isBroadcastingRef = useRef(false)
  const pendingVisibilityRef = useRef<boolean | null>(null)
  const lastAppliedVisibilityRef = useRef<boolean | null>(null)
  const hiddenMaintenanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hiddenMaintenanceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const broadcastVisibility = (isVisible: boolean): void => {
      if (isBroadcastingRef.current) {
        pendingVisibilityRef.current = isVisible
        return
      }

      isBroadcastingRef.current = true
      visibilityApi
        .setVisibilityState(isVisible)
        .catch((err) => {
          console.warn('[Visibility] Failed to broadcast visibility state:', err)
        })
        .finally(() => {
          isBroadcastingRef.current = false

          if (pendingVisibilityRef.current === null || pendingVisibilityRef.current === isVisible) {
            pendingVisibilityRef.current = null
            return
          }

          const pendingVisibility = pendingVisibilityRef.current
          pendingVisibilityRef.current = null
          broadcastVisibility(pendingVisibility)
        })
    }

    const clearHiddenMaintenance = (): void => {
      if (hiddenMaintenanceTimeoutRef.current) {
        clearTimeout(hiddenMaintenanceTimeoutRef.current)
        hiddenMaintenanceTimeoutRef.current = null
      }
      if (hiddenMaintenanceIntervalRef.current) {
        clearInterval(hiddenMaintenanceIntervalRef.current)
        hiddenMaintenanceIntervalRef.current = null
      }
    }

    const scheduleHiddenMaintenance = (): void => {
      if (hiddenMaintenanceTimeoutRef.current || hiddenMaintenanceIntervalRef.current) {
        return
      }

      hiddenMaintenanceTimeoutRef.current = setTimeout(() => {
        useTerminalStore.getState().truncateHiddenTerminalBuffers()
        hiddenMaintenanceTimeoutRef.current = null
        hiddenMaintenanceIntervalRef.current = setInterval(() => {
          useTerminalStore.getState().truncateHiddenTerminalBuffers()
        }, HIDDEN_BUFFER_TRUNCATION_DELAY)
      }, HIDDEN_BUFFER_TRUNCATION_DELAY)
    }

    const applyVisibility = (isVisible: boolean): void => {
      if (lastAppliedVisibilityRef.current === isVisible) {
        return
      }

      lastAppliedVisibilityRef.current = isVisible
      if (import.meta.env.DEV) {
        console.debug('[Visibility] App visibility changed:', isVisible)
      }
      applyAppHiddenState(isVisible)

      if (isVisible) {
        clearHiddenMaintenance()
      } else {
        scheduleHiddenMaintenance()
      }

      broadcastVisibility(isVisible)
    }

    const syncVisibilityState = async (): Promise<void> => {
      const documentVisible = document.visibilityState === 'visible'

      if (!isTauriContext()) {
        applyVisibility(documentVisible)
        return
      }

      try {
        const isMinimized = await getCurrentWindow().isMinimized()
        applyVisibility(documentVisible && !isMinimized)
      } catch {
        applyVisibility(documentVisible)
      }
    }

    const handleVisibilityChange = (): void => {
      void syncVisibilityState()
    }

    let focusChangeUnlisten: Promise<() => void> | undefined

    if (isFirstRun.current) {
      isFirstRun.current = false
      if (import.meta.env.DEV) {
        console.debug('[Visibility] Initial state:', document.visibilityState === 'visible')
      }
      void syncVisibilityState()
    }

    if (isTauriContext()) {
      const appWindow = getCurrentWindow()
      focusChangeUnlisten = appWindow.onFocusChanged(() => {
        void syncVisibilityState()
      })
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      clearHiddenMaintenance()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      cleanupTauriListener(focusChangeUnlisten)
    }
  }, [])
}
