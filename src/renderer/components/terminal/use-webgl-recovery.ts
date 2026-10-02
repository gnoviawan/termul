import type { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'
import { type MutableRefObject, type RefObject, useCallback, useEffect, useRef } from 'react'
import { logFrontendError } from '@/lib/log-api'

export const MAX_WEBGL_RECOVERY_ATTEMPTS = 3
export const WEBGL_CONTEXT_LOSS_RECOVERY_DELAY_MS = 100

const WEBGL_ADDON_PACKAGE = '@xterm/addon-webgl'

// Story 3 (WebGL high-DPR root fix): current window DPR, defensively read —
// jsdom and some embedded webviews leave devicePixelRatio undefined.
export const getDevicePixelRatio = (): number => {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : undefined
  return typeof dpr === 'number' && dpr > 0 ? dpr : 1
}

// Story 3: context for the WebGL failure log (log-api) — dpr, css size, addon
// version. Metadata only, never secrets. Serialized into the log message so
// the whole context lands on one durable line.
export const describeWebglContext = (terminal: Terminal | null): string => {
  const rect = terminal?.element?.getBoundingClientRect()
  const css = rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : 'unmeasured'
  return `dpr=${getDevicePixelRatio()} css=${css} addon=${WEBGL_ADDON_PACKAGE}`
}

// Story 3: force the WebGL renderer to recompute its dimensions at the
// CURRENT devicePixelRatio. The addon's WebglRenderer captures dpr once in its
// constructor and re-reads it only in handleDevicePixelRatioChange, which the
// xterm core invokes for the active renderer via coreBrowserService.onDprChange
// (matchMedia '(resolution: Xdppx)'). At our load seam the addon activates
// before char-size measurement, so its internal dimensions can be stale/zero
// while the canvas backing store (devicePixelContentBoxSize observer) is
// already correct — the blank-canvas-at-DPR>=3 split. Driving the same
// re-sync the core performs for DPR changes (renderService's
// handleDevicePixelRatioChange + a full refresh) plus a forced fit closes the
// gap without touching addon internals. Core services are not public API —
// every access is feature-detected and guarded; a throw degrades to the
// caller's failure log, never a crash.
export const resyncWebglDimensions = (terminal: Terminal): void => {
  // xterm core internals are not public API. Feature-detect via runtime shape
  // checks on unknown (project rule: no unchecked casts at internal seams).
  const core: unknown = (terminal as { _core?: unknown })._core
  const renderService: unknown =
    typeof core === 'object' && core !== null && '_renderService' in core
      ? core._renderService
      : undefined
  const handleDevicePixelRatioChange: unknown =
    typeof renderService === 'object' && renderService !== null
      ? 'handleDevicePixelRatioChange' in renderService
        ? renderService.handleDevicePixelRatioChange
        : undefined
      : undefined
  if (typeof handleDevicePixelRatioChange === 'function') {
    // CodeRabbit: RenderService.handleDevicePixelRatioChange reads
    // _charSizeService/_renderer through `this`; call it with the service
    // as the receiver or it throws before the refresh below.
    handleDevicePixelRatioChange.call(renderService)
  }
  terminal.refresh(0, terminal.rows - 1)
}

// Renderer resolution (story 2 mobile stopgap): unified with the
// terminal-factory helper — 'auto' (the shipped default) resolves to WebGL
// on desktop and to the DOM renderer on the mobile web shell, where WebGL
// paints zero pixels at DPR >= 3. Explicit 'webgl'/'dom' is always honored.
export const shouldUseWebglRenderer = (
  rendererPreference: 'auto' | 'webgl' | 'dom',
  isMobileWebShell: boolean
): boolean => {
  if (rendererPreference === 'dom') return false
  if (rendererPreference === 'webgl') return true
  return !isMobileWebShell
}

export interface UseWebglRecoveryOptions {
  /** Ref to the xterm.js Terminal instance (updated lazily by the component) */
  terminalRef: RefObject<Terminal | null>
  /** Ref to the live WebglAddon — owned by the component, mutated through here */
  webglAddonRef: MutableRefObject<WebglAddon | null>
  /** Live handle to the EFFECTIVE renderer preference (mobile 'auto'→'dom' flip applied) */
  rendererPreferenceRef: MutableRefObject<'auto' | 'webgl' | 'dom'>
  /** Live handle to the mobile-web-shell flag for event-listener closures */
  isMobileWebShellRef: MutableRefObject<boolean>
  /** Effective renderer preference (mobile flip applied) */
  effectiveRendererPreference: 'auto' | 'webgl' | 'dom'
  /** Raw renderer preference from app settings (drives the flip log) */
  rendererPreference: 'auto' | 'webgl' | 'dom'
  isMobileWebShell: boolean
}

export interface UseWebglRecoveryReturn {
  disposeWebglAddon: () => void
  loadWebglAddonRef: MutableRefObject<((term: Terminal, isRecovery?: boolean) => void) | null>
  webglRecoveryAttemptsRef: MutableRefObject<number>
  webglRecoveryTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
  webglContextLostRef: MutableRefObject<boolean>
  webglDprWatchedRef: MutableRefObject<number>
}

/**
 * WebGL recovery state machine for ConnectedTerminal: owns the attempt
 * counters, recovery timeout, context-loss/DPR bookkeeping refs, the addon
 * dispose path, and the recovery trigger effects (renderer-preference flips,
 * mobile-shell resolution logging, devicePixelRatio change watch).
 *
 * The addon instantiation path (`loadWebglAddon`) stays in the component's
 * init effects — it writes the freshly loaded addon back through
 * `loadWebglAddonRef` so these triggers can re-arm it.
 */
export function useWebglRecovery(options: UseWebglRecoveryOptions): UseWebglRecoveryReturn {
  const {
    terminalRef,
    webglAddonRef,
    rendererPreferenceRef,
    isMobileWebShellRef,
    effectiveRendererPreference,
    rendererPreference,
    isMobileWebShell
  } = options

  const webglRecoveryAttemptsRef = useRef<number>(0)
  const webglRecoveryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadWebglAddonRef = useRef<((term: Terminal, isRecovery?: boolean) => void) | null>(null)
  const webglContextLostRef = useRef<boolean>(false)
  // Story 3: devicePixelRatio the current WebGL addon was synced/loaded at.
  // Nonzero while an addon is live and its DPR watch is armed; reset to 0 on
  // dispose so a re-loaded addon (recovery / DPR-change re-init) re-syncs at
  // the CURRENT dpr, not the stale watch-time value.
  const webglDprWatchedRef = useRef<number>(0)
  const mobileRendererFlipLoggedRef = useRef(false)

  const disposeWebglAddon = useCallback((): void => {
    if (webglRecoveryTimeoutRef.current) {
      clearTimeout(webglRecoveryTimeoutRef.current)
      webglRecoveryTimeoutRef.current = null
    }
    if (webglAddonRef.current) {
      webglAddonRef.current.dispose()
      webglAddonRef.current = null
    }
    webglContextLostRef.current = false
    // Story 3: the addon loaded after this watch started (recovery/DPR-change
    // re-init) must be re-synced at the CURRENT dpr, not the watch-time one.
    webglDprWatchedRef.current = 0
  }, [webglAddonRef])

  useEffect(() => {
    if (!shouldUseWebglRenderer(effectiveRendererPreference, isMobileWebShell)) {
      disposeWebglAddon()
      webglRecoveryAttemptsRef.current = 0
      return
    }

    if (terminalRef.current && loadWebglAddonRef.current && !webglAddonRef.current) {
      webglRecoveryAttemptsRef.current = 0
      loadWebglAddonRef.current(terminalRef.current)
    }
  }, [disposeWebglAddon, effectiveRendererPreference, isMobileWebShell, terminalRef, webglAddonRef])

  // Story 2: durable boundary log when the mobile web shell flips the
  // effective renderer default to DOM. Once per terminal instance per flip
  // episode (the guard ref resets when the flip goes away, so a later
  // re-flip logs again — e.g. desktop→narrow-viewport rotation). Metadata
  // only: preferences and shell state, never secrets.
  useEffect(() => {
    const flipped = isMobileWebShell && rendererPreference === 'auto'
    if (flipped && !mobileRendererFlipLoggedRef.current) {
      mobileRendererFlipLoggedRef.current = true
      void logFrontendError({
        level: 'warn',
        source: 'ConnectedTerminal.rendererResolution',
        message:
          'mobile web shell: effective renderer default flipped auto->dom (WebGL blank at DPR>=3 stopgap; explicit webgl/dom always honored; story 3 is the root fix)'
      })
    } else if (!flipped) {
      mobileRendererFlipLoggedRef.current = false
    }
  }, [isMobileWebShell, rendererPreference])

  // Story 3 (P1, stale canvas on DPR change): watch devicePixelRatio and
  // re-init the WebGL addon when it changes (zoom, monitor switch, rotation).
  // The addon's WebglRenderer captures dpr once at construction; xterm's core
  // does forward onDprChange to the active renderer, but the canvas backing
  // store correction races the zoom's CSS transition, leaving text at the old
  // scale until an explicit resize. A dispose + reload at our seam rebuilds
  // the renderer AND its texture atlas at the new dpr — the same re-init the
  // proven context-loss recovery path performs.
  //
  // Detection: prefer matchMedia('(resolution: ${dpr}dppx)') (fires exactly
  // when the current dpr stops matching). Fallback when matchMedia is
  // unavailable (or the resolution query throws): window 'resize' listener +
  // dpr comparison — a zoom always fires resize.
  //
  // Desktop-DPR-1 unchanged (matrix row 5): the listener is armed but idle
  // while dpr stays 1 — no re-init, no perf churn.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are the intended live handles; effect must not re-subscribe per render
  useEffect(() => {
    if (!shouldUseWebglRenderer(rendererPreferenceRef.current, isMobileWebShellRef.current)) {
      // DOM preference: no addon, no DPR listener churn (matrix row 4).
      return
    }

    let disposed = false
    const handleDprChange = (): void => {
      if (disposed) return
      const term = terminalRef.current
      const previousDpr = webglDprWatchedRef.current
      const currentDpr = getDevicePixelRatio()
      // Only act on a real change while an addon is live; the mount-time load
      // (or a preference flip to webgl) arms the watch via webglDprWatchedRef.
      if (!term || !webglAddonRef.current || previousDpr === currentDpr) return
      webglDprWatchedRef.current = 0
      // Full re-init: dispose (resets the watch flag) then reload, which
      // re-syncs dimensions at the NEW dpr on load.
      disposeWebglAddon()
      webglRecoveryAttemptsRef.current = 0
      loadWebglAddonRef.current?.(term, false)
      if (!webglAddonRef.current) {
        // Reload failed (construction throws at this dpr, or retries
        // exhausted) — xterm falls back to the DOM renderer. Durable failure
        // log with dpr context; never secrets.
        void logFrontendError({
          level: 'error',
          source: 'ConnectedTerminal.dprChange',
          message: `WebGL addon re-init failed after devicePixelRatio change ${previousDpr} -> ${currentDpr}; terminal remains on the DOM renderer (${describeWebglContext(term)})`
        })
      }
      // CodeRabbit: re-arm the resolution query at the NEW dpr — the query
      // bound at the old dpr is stale (already false), so a later dpr
      // transition would never fire another `change` event. Re-subscribing
      // here keeps multi-step transitions (1→2→3, monitor switches) live.
      rearmResolutionQuery()
    }

    // Resolution-query subscription management: `matchMedia('(resolution:
    // Xdppx)')` fires `change` exactly when the dpr STOPS matching X — after
    // handling a transition, the query must be recreated at the new dpr or
    // later transitions go undetected (CodeRabbit). Centralized so the
    // initial arm and every re-arm share one detach path.
    let mediaQueryList: MediaQueryList | null = null
    let mediaListener: (() => void) | null = null
    let resizeListener: (() => void) | null = null

    const detachMediaQuery = (): void => {
      if (mediaQueryList && mediaListener) {
        if (typeof mediaQueryList.removeEventListener === 'function') {
          mediaQueryList.removeEventListener('change', mediaListener)
        } else if (typeof mediaQueryList.removeListener === 'function') {
          mediaQueryList.removeListener(mediaListener)
        }
      }
      mediaQueryList = null
      mediaListener = null
    }

    const rearmResolutionQuery = (): void => {
      if (disposed || typeof window === 'undefined') return
      if (typeof window.matchMedia !== 'function') return
      detachMediaQuery()
      try {
        mediaQueryList = window.matchMedia(`(resolution: ${getDevicePixelRatio()}dppx)`)
        mediaListener = handleDprChange
        if (typeof mediaQueryList.addEventListener === 'function') {
          mediaQueryList.addEventListener('change', mediaListener)
        } else if (typeof mediaQueryList.addListener === 'function') {
          // Legacy Safari (pre-14) API — the same pattern xterm's
          // ScreenDprMonitor uses.
          mediaQueryList.addListener(mediaListener)
        } else {
          mediaListener = null
          mediaQueryList = null
        }
      } catch {
        mediaQueryList = null
        mediaListener = null
      }
    }

    rearmResolutionQuery()

    if (!mediaListener && typeof window !== 'undefined') {
      // matchMedia unavailable or rejected the resolution query: fall back to
      // resize-event polling (spec: fallback ONLY when matchMedia is absent).
      resizeListener = () => {
        if (
          webglDprWatchedRef.current !== 0 &&
          webglDprWatchedRef.current !== getDevicePixelRatio()
        ) {
          handleDprChange()
        } else if (webglDprWatchedRef.current === 0 && webglAddonRef.current) {
          // Addon loaded after this effect armed — catch a missed dpr change.
          webglDprWatchedRef.current = getDevicePixelRatio()
        }
      }
      window.addEventListener('resize', resizeListener)
    }

    return () => {
      disposed = true
      detachMediaQuery()
      if (resizeListener) {
        window.removeEventListener('resize', resizeListener)
      }
    }
  }, [disposeWebglAddon, effectiveRendererPreference, isMobileWebShell])

  return {
    disposeWebglAddon,
    loadWebglAddonRef,
    webglRecoveryAttemptsRef,
    webglRecoveryTimeoutRef,
    webglContextLostRef,
    webglDprWatchedRef
  }
}
