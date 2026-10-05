import type { FitAddon } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import { type MutableRefObject, type RefObject, useCallback, useEffect, useRef } from 'react'
import { systemApi } from '@/lib/api'
import { useTerminalStore } from '@/stores/terminal-store'
import { restoreScrollPosition } from '../../utils/terminal-registry'

const VISIBILITY_RECOVERY_DELAY_MS = 150
const POWER_RESUME_RECOVERY_DELAY_MS = 300
const ACTIVITY_DEBOUNCE_MS = 1000

export interface UseTerminalFitOptions {
  /** Ref to the xterm.js Terminal instance (updated lazily) */
  terminalRef: RefObject<Terminal | null>
  /** Ref to the FitAddon instance (updated lazily) */
  fitAddonRef: RefObject<FitAddon | null>
  /** The container element whose rect drives fit() */
  containerRef: RefObject<HTMLDivElement | null>
  /** Live handle to the bound PTY id (null until spawn/attach completes) */
  ptyIdRef: RefObject<string | null>
  /** Tab-active flag ref — recovery guards read the latest value */
  isVisibleRef: RefObject<boolean>
  /** Whether the terminal tab is currently the active one in its pane */
  isVisible: boolean
  /** Store terminal id used to resolve the activity record on unmount */
  targetId: string | undefined
  /** Pending WebGL context-loss recovery timer — recovery cancels it to avoid
      a double-creation race with the genuine onContextLoss path */
  webglRecoveryTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  /** Immediate fit + PTY resize that bypasses both debounce stages */
  forceResizeFit: () => void
}

export interface UseTerminalFitReturn {
  /** Fit to container size; returns false when skipped or fit() threw */
  performFit: (force?: boolean) => boolean
  /** Set when a fit+resize was deferred until PTY spawn completes */
  needsResizeOnReadyRef: MutableRefObject<boolean>
  /** Debounced sidebar activity indicator update for PTY output */
  noteTerminalActivity: (terminalId: string) => void
  /** Clears the sidebar activity indicator on unmount (e.g. tab switch) */
  clearTerminalActivityOnUnmount: () => void
}

/**
 * Fit/resize/visibility recovery chains for ConnectedTerminal: the guarded
 * performFit, the PTY-activity debounce (sidebar indicator), the deferred
 * fit-on-spawn flag, and the recovery triggers for window restore —
 * visibilitychange, window focus, and power-resume. The xterm instance and
 * addon refs stay component-owned and arrive here via options.
 */
export function useTerminalFit(options: UseTerminalFitOptions): UseTerminalFitReturn {
  const {
    terminalRef,
    fitAddonRef,
    containerRef,
    ptyIdRef,
    isVisibleRef,
    isVisible,
    targetId,
    webglRecoveryTimeoutRef,
    forceResizeFit
  } = options

  // Single-flight guard for performTerminalRecovery. On a window restore both
  // the visibilitychange and focus handlers (and sometimes power-resume) can
  // fire close together; without this guard each would start its own
  // layout-wait RAF loop and overlapping fit + visibility-flip cycles.
  const recoveryInProgressRef = useRef<boolean>(false)
  const needsResizeOnReadyRef = useRef<boolean>(false)
  // Track last fitted container dimensions to avoid redundant fit() calls
  const lastContainerWidthRef = useRef<number>(0)
  const lastContainerHeightRef = useRef<number>(0)
  const activityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastActivityUpdateRef = useRef<number>(0)
  const pendingActivityUpdateRef = useRef<{ id: string } | null>(null)

  const performFit = useCallback(
    (force = false): boolean => {
      if (!fitAddonRef.current || !terminalRef.current || !containerRef.current) return false
      const rect = containerRef.current.getBoundingClientRect()
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)
      if (
        !force &&
        width > 0 &&
        height > 0 &&
        width === lastContainerWidthRef.current &&
        height === lastContainerHeightRef.current
      ) {
        return false
      }
      try {
        fitAddonRef.current.fit()
        if (width > 0 && height > 0) {
          lastContainerWidthRef.current = width
          lastContainerHeightRef.current = height
        }
        return true
      } catch {
        return false
      }
    },
    [containerRef, fitAddonRef, terminalRef]
  )

  const noteTerminalActivity = useCallback((terminalId: string): void => {
    const now = Date.now()
    const timeSinceLastUpdate = now - lastActivityUpdateRef.current

    // If enough time has passed since last update, update immediately
    if (timeSinceLastUpdate >= ACTIVITY_DEBOUNCE_MS) {
      useTerminalStore.getState().updateTerminalActivityBatch(terminalId, true, now)
      lastActivityUpdateRef.current = now
    } else {
      // Otherwise, store pending update for later
      pendingActivityUpdateRef.current = { id: terminalId }
    }

    // Clear existing activity timeout and set new one
    if (activityTimeoutRef.current) {
      clearTimeout(activityTimeoutRef.current)
    }
    activityTimeoutRef.current = setTimeout(() => {
      // Flush any pending activity update
      if (pendingActivityUpdateRef.current) {
        useTerminalStore
          .getState()
          .updateTerminalActivityBatch(pendingActivityUpdateRef.current.id, false, Date.now())
        pendingActivityUpdateRef.current = null
      } else {
        // Clear activity after 2 seconds of inactivity
        useTerminalStore.getState().updateTerminalActivityBatch(terminalId, false, Date.now())
      }
      activityTimeoutRef.current = null
      lastActivityUpdateRef.current = 0
    }, 2000)
  }, [])

  /** Clear sidebar activity indicator when this view unmounts (e.g. tab switch). */
  const clearTerminalActivityOnUnmount = useCallback((): void => {
    if (activityTimeoutRef.current) {
      clearTimeout(activityTimeoutRef.current)
      activityTimeoutRef.current = null
    }
    pendingActivityUpdateRef.current = null
    lastActivityUpdateRef.current = 0

    const store = useTerminalStore.getState()
    const storeTerminalId =
      (ptyIdRef.current ? store.findTerminalByPtyId(ptyIdRef.current)?.id : undefined) ??
      (targetId
        ? (store.terminals.find((t) => t.id === targetId)?.id ??
          store.findTerminalByPtyId(targetId)?.id)
        : undefined)

    if (storeTerminalId) {
      store.updateTerminalActivityBatch(storeTerminalId, false, Date.now())
    }
  }, [ptyIdRef, targetId])

  // Trigger fit + PTY resize when terminal becomes visible
  // Uses the two-stage resize pipeline via forceResizeFit,
  // which skips both debounces for immediate responsiveness.
  useEffect(() => {
    if (isVisible && fitAddonRef.current && terminalRef.current) {
      // Double RAF ensures DOM is fully rendered after pane transition
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          // Use forceResizeFit for immediate fit + PTY resize
          // This bypasses both debounce stages for visibility changes
          forceResizeFit()

          const terminal = terminalRef.current
          if (!terminal) return

          // Only focus if no interactive element (button, input, etc.) currently has focus.
          // This prevents stealing focus from TitleBar window controls when tab switch happens.
          const active = document.activeElement
          const isInteractiveElementFocused =
            active &&
            active !== document.body &&
            (active.tagName === 'BUTTON' ||
              active.tagName === 'INPUT' ||
              active.tagName === 'TEXTAREA' ||
              active.tagName === 'SELECT' ||
              active.tagName === 'A')
          if (!isInteractiveElementFocused) {
            terminal.focus()
          }

          const ptyId = ptyIdRef.current
          if (ptyId) {
            // Restore scroll position after fit (in case of pane transition)
            restoreScrollPosition(ptyId, terminal)
          } else {
            // PTY not ready yet — defer resize until spawn completes
            needsResizeOnReadyRef.current = true
          }
        })
      })
    }
  }, [isVisible, forceResizeFit, fitAddonRef, terminalRef, ptyIdRef])

  // Shared terminal recovery logic - re-fit once layout is stable, then nudge
  // the compositor to re-present the canvas layer.
  const performTerminalRecovery = useCallback((): void => {
    if (!fitAddonRef.current || !terminalRef.current) return

    // Single-flight: if a recovery is already running (layout-wait poll or the
    // trailing visibility-flip RAF), skip duplicate triggers. On a window
    // restore both visibilitychange and focus typically fire close together.
    if (recoveryInProgressRef.current) return
    recoveryInProgressRef.current = true

    // Cancel any pending WebGL auto-recovery timeout to avoid double-creation
    // race with the genuine onContextLoss path.
    if (webglRecoveryTimeoutRef.current) {
      clearTimeout(webglRecoveryTimeoutRef.current)
      webglRecoveryTimeoutRef.current = null
    }

    // Root cause (verified via live forensics + xterm.js #4841 / #5357):
    //
    // After minimize→restore on Windows the webview reflows over several
    // frames. If fit() runs while the container height is still collapsed,
    // the terminal grid shrinks to 1-2 rows (PTY redraws tiny → "1-2 lines"
    // of text) until a later resize corrects it. The fit pipeline now guards
    // against collapsed dimensions (use-terminal-resize-v2), so an early fit
    // is a safe no-op rather than a destructive shrink.
    //
    // Additionally, the WebView2 compositor may not re-present the WebGL
    // canvas layer after restore (xterm 6.x has no DOM-row fallback; the
    // context itself stays healthy). A CSS visibility flip forces a
    // re-composite — the same mechanism that makes tab-switching work.
    //
    // Strategy: wait for the container to report a usable size (poll across a
    // few RAFs), then forceResizeFit + refresh, then flip visibility to
    // guarantee the layer re-composites.
    const termEl = terminalRef.current.element as HTMLElement | undefined
    const container = containerRef.current

    const MIN_USABLE = 40
    const MAX_LAYOUT_WAIT_FRAMES = 30 // ~0.5s at 60fps

    const runRecovery = (): void => {
      const terminal = terminalRef.current
      if (!terminal) {
        recoveryInProgressRef.current = false
        return
      }
      // Re-fit (guarded against collapsed dims) + redraw the buffer.
      forceResizeFit()
      terminal.refresh(0, terminal.rows - 1)

      // Nudge the compositor to re-present the canvas layer. Clear the
      // single-flight guard only after the trailing refresh completes.
      if (termEl) {
        termEl.style.visibility = 'hidden'
        requestAnimationFrame(() => {
          termEl.style.visibility = ''
          const t = terminalRef.current
          if (t) t.refresh(0, t.rows - 1)
          recoveryInProgressRef.current = false
        })
      } else {
        recoveryInProgressRef.current = false
      }
    }

    // Wait until the container has reflowed to a usable size before fitting,
    // so we never collapse the grid. Bail out after MAX_LAYOUT_WAIT_FRAMES.
    let frames = 0
    const waitForStableLayout = (): void => {
      const rect = container?.getBoundingClientRect()
      const ready = !!rect && rect.width >= MIN_USABLE && rect.height >= MIN_USABLE
      if (ready || frames >= MAX_LAYOUT_WAIT_FRAMES) {
        runRecovery()
        return
      }
      frames += 1
      requestAnimationFrame(waitForStableLayout)
    }
    waitForStableLayout()
  }, [containerRef, fitAddonRef, forceResizeFit, terminalRef, webglRecoveryTimeoutRef])

  // Recovery handler for visibility change (app regains focus after idle)
  useEffect(() => {
    // Track timeout to prevent firing after unmount
    let recoveryTimeoutId: ReturnType<typeof setTimeout> | null = null

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        // Clear any pending timeout before scheduling new one
        if (recoveryTimeoutId) {
          clearTimeout(recoveryTimeoutId)
        }
        recoveryTimeoutId = setTimeout(() => {
          recoveryTimeoutId = null
          performTerminalRecovery()
        }, VISIBILITY_RECOVERY_DELAY_MS)
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      if (recoveryTimeoutId) {
        clearTimeout(recoveryTimeoutId)
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [performTerminalRecovery])

  // Recovery handler for window focus — critical for Tauri minimize/restore
  // on Windows where document.visibilitychange is unreliable.
  // The window 'focus' event reliably fires when the window is restored from
  // taskbar minimize. performTerminalRecovery re-fits the terminal to its
  // container and syncs PTY dimensions (SIGWINCH to the shell process).
  useEffect(() => {
    const handleWindowFocus = (): void => {
      // Skip recovery for terminals that are not the active tab in their pane
      // (isVisible is tab-active, not window-visible — see PaneContent.tsx).
      // Hidden instances recover via the isVisible-change useEffect instead.
      if (!isVisibleRef.current) return
      // Fire recovery immediately — the window is already visible when
      // 'focus' fires (unlike visibilitychange which needs DOM reflow time).
      // performTerminalRecovery internally waits for a stable layout before
      // fitting and is single-flight guarded, so this is safe to call eagerly.
      performTerminalRecovery()
    }

    window.addEventListener('focus', handleWindowFocus)
    return () => {
      window.removeEventListener('focus', handleWindowFocus)
    }
  }, [performTerminalRecovery, isVisibleRef])

  // Recovery handler for power resume (wake from sleep, screen unlock)
  useEffect(() => {
    // Track timeout to prevent firing after unmount
    let recoveryTimeoutId: ReturnType<typeof setTimeout> | null = null

    const cleanup = systemApi.onPowerResume(() => {
      // Clear any pending timeout before scheduling new one
      if (recoveryTimeoutId) {
        clearTimeout(recoveryTimeoutId)
      }
      recoveryTimeoutId = setTimeout(() => {
        recoveryTimeoutId = null
        performTerminalRecovery()
      }, POWER_RESUME_RECOVERY_DELAY_MS)
    })
    return () => {
      if (recoveryTimeoutId) {
        clearTimeout(recoveryTimeoutId)
      }
      cleanup()
    }
  }, [performTerminalRecovery])

  return {
    performFit,
    needsResizeOnReadyRef,
    noteTerminalActivity,
    clearTerminalActivityOnUnmount
  }
}
