/**
 * GPUIX override of `components/terminal/ConnectedTerminal.tsx`.
 *
 * Same props, store wiring and lifecycle as the DOM component, painted by the
 * native `TerminalView` over an `@xterm/headless` screen. The screen enters
 * the shared registry and terminal cache as its xterm facade, so scrollback
 * persistence, DEC mode tracking, theme changes and the cache across project
 * switches are the shared code. A hidden view keeps parsing output and paints
 * the current frame the moment it is shown again; unmounting caches the
 * screen while the PTY lives, and a remount takes it back with only the
 * missed-output delta replayed.
 */

import { type EventPayload, type KeyEvent, type PublicInstance, useGpuix } from '@gpuix/react'
import type { TerminalModes, TerminalSpawnOptions } from '@shared/types/ipc.types'
import type React from 'react'
import {
  forwardRef,
  memo,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'
import { AgentConnectionLamp } from '@/components/chat/AgentConnectionLamp'
import { AlertTriangle, RefreshCcw } from '@/components/icons'
import { getInstrumentationProjectId } from '@/components/terminal/instrumentation'
import { isAppOwnedTerminalShortcut, SHORTCUT_MOD } from '@/components/terminal/keymap'
import { activityTerminalId, createTerminalActivity } from '@/components/terminal/terminal-activity'
import { cacheTerminal, takeCachedTerminal } from '@/components/terminal/terminal-cache'
import { DEFAULT_TERMINAL_OPTIONS } from '@/components/terminal/terminal-config'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useTerminalClipboard } from '@/hooks/use-terminal-clipboard'
import { PTY_RESIZE_DEBOUNCE_MS } from '@/hooks/use-terminal-resize-v2'
import { isTerminalPendingPtyAssignment } from '@/hooks/use-terminal-restore'
import { terminalApi } from '@/lib/api'
import { openTerminalUrl } from '@/lib/browser/terminal-url-navigation'
import { openFilePathFromTerminal } from '@/lib/file-path-links'
import { logFrontendError } from '@/lib/log-api'
import { isMac } from '@/lib/platform'
import { isTauriContext } from '@/lib/tauri-runtime'
import { isSupportedTerminalUrl } from '@/lib/terminal-url-links'
import { getActiveTerminalTheme } from '@/lib/themes/apply-color-theme'
import { isWebTerminalBufferable, onWebTerminalSessionLost } from '@/lib/web-terminal-api'
import { useAcpStore } from '@/stores/acp-store'
import { useTerminalBufferSize, useTerminalFontSize } from '@/stores/app-settings-store'
import { useConnectionStatusStore } from '@/stores/connection-status-store'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { useProjectStore } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import { useProjectPaneContext } from '@/stores/workspace-store/pane-context'
import {
  captureScrollPosition,
  registerTerminal,
  unregisterTerminal
} from '@/utils/terminal-registry'
import { windowKeyEvent } from '../../../compat/events'
import { log } from '../../../log'
import { tw } from '../../../style/tw'
import { bindSession } from '../../../terminal/connected-session'
import { linkAt } from '../../../terminal/links'
import { TerminalScreen } from '../../../terminal/screen'
import { TerminalView } from '../../../terminal/TerminalView'
import { asXterm, screenOf } from '../../../terminal/xterm-facade'
import { toMouseEvent, type UiMouseEvent } from '../../../ui/internal/host'
import { TerminalAssistPanel, type TerminalAssistPanelState } from './TerminalAssistPanel'

export interface TerminalSearchHandle {
  findNext: (term: string) => boolean
  findPrevious: (term: string) => boolean
  clearDecorations: () => void
  writeText: (text: string) => void
}

export interface ConnectedTerminalProps {
  terminalId?: string
  storeTerminalId?: string
  spawnOptions?: TerminalSpawnOptions
  onSpawned?: (terminalId: string) => void
  autoSpawn?: boolean
  onBoundToStoreTerminal?: (ptyId: string) => void
  onExit?: (exitCode: number, signal?: number) => void
  onError?: (error: string) => void
  onCommand?: (command: string) => void
  className?: string
  autoFocus?: boolean
  initialScrollback?: string[]
  initialModes?: TerminalModes | null
  searchRef?: React.Ref<TerminalSearchHandle>
  isVisible?: boolean
}

/** A spawning view waits this long for its first fit before spawning at the screen's size. */
const SPAWN_FIT_WAIT_MS = 500

const OVERLAY_BACKDROP =
  'absolute inset-0 z-50 flex items-center justify-center bg-background/40 p-8 text-foreground'
const OVERLAY_CARD =
  'flex w-full max-w-2xl flex-row gap-6 rounded-2xl border border-border/50 bg-card/95 p-8 shadow-2xl'

interface SessionOverlayProps {
  tone: 'destructive' | 'warning'
  badge: string
  eyebrow: string
  title: string
  body: string
  action: string
  reference: string | undefined
  onAction: () => void
}

/** The crash and dead-session overlays: one card, two tones (desktop `md:` layout). */
function SessionOverlay(props: SessionOverlayProps): React.JSX.Element {
  const toneText = props.tone === 'destructive' ? 'text-destructive' : 'text-warning'
  const toneWash = props.tone === 'destructive' ? 'bg-destructive/10' : 'bg-warning/10'
  const toneEdge = props.tone === 'destructive' ? 'border-t-destructive' : 'border-t-warning'
  return (
    <div style={tw(OVERLAY_BACKDROP)}>
      <div style={{ ...tw(`${OVERLAY_CARD} ${toneEdge}`), borderTopWidth: 4 }}>
        <div
          style={tw(
            'flex w-[140px] shrink-0 flex-col items-center justify-center border-r border-border/50 pr-6'
          )}
        >
          <div
            style={tw(`mb-3 flex h-20 w-20 items-center justify-center rounded-2xl ${toneWash}`)}
          >
            <AlertTriangle className={toneText} size={40} />
          </div>
          <text style={tw(`text-center text-xs font-medium ${toneText}`)}>{props.badge}</text>
        </div>
        <div style={tw('flex min-w-0 flex-1 flex-col justify-center text-left')}>
          <text style={tw('mb-1 text-xs font-medium text-muted-foreground')}>{props.eyebrow}</text>
          <text style={tw('mb-3 text-3xl font-bold tracking-tighter')}>{props.title}</text>
          <text style={tw('mb-8 text-base leading-relaxed text-muted-foreground')}>
            {props.body}
          </text>
          <div style={tw('flex flex-row items-center gap-4')}>
            <Button type="button" size="sm" onClick={props.onAction}>
              <RefreshCcw /> {props.action}
            </Button>
            <div style={tw('mx-2 h-8 w-px bg-border/50')} />
            <text style={tw('font-mono text-3xs text-muted-foreground/60')}>
              {`REF::${props.reference?.slice(0, 8) ?? ''}`}
            </text>
          </div>
        </div>
      </div>
    </div>
  )
}

function channelLabel(
  channel: ReturnType<typeof useConnectionStatusStore.getState>['terminalChannel'],
  bufferable: boolean
): string {
  if (channel === 'disconnected') return 'Disconnected'
  if (channel === 'host-offline')
    return bufferable ? 'Host offline — input buffered' : 'Host offline'
  if (channel === 'reconnecting')
    return bufferable ? 'Reconnecting — input buffered' : 'Reconnecting…'
  return 'Connecting…'
}

type TerminalHostProps = React.ComponentProps<typeof TerminalView>

/**
 * `ContextMenuTrigger asChild` target: GPUI clicks do not bubble, so the
 * terminal element itself takes the right press the trigger listens for.
 */
const TerminalHost = forwardRef<
  PublicInstance,
  TerminalHostProps & { onAuxClick?: unknown; onContextMenu?: unknown }
>(function TerminalHost({ onAuxClick, onContextMenu, ...props }, ref) {
  const aux = onAuxClick as ((event: UiMouseEvent) => void) | undefined
  const menu = onContextMenu as ((event: UiMouseEvent) => void) | undefined
  const forward =
    aux || menu
      ? (event: EventPayload) => {
          const mouse = toMouseEvent(event)
          aux?.(mouse)
          if (mouse.button === 2) menu?.(mouse)
        }
      : undefined
  return <TerminalView {...props} hostRef={ref as Ref<PublicInstance>} onAuxClick={forward} />
})

function ConnectedTerminalComponent({
  terminalId: externalTerminalId,
  storeTerminalId,
  spawnOptions,
  onSpawned,
  autoSpawn = true,
  onExit,
  onError,
  onCommand,
  onBoundToStoreTerminal,
  className = '',
  autoFocus = true,
  initialScrollback,
  initialModes,
  searchRef,
  isVisible = true
}: ConnectedTerminalProps): React.JSX.Element {
  const targetId = storeTerminalId || externalTerminalId
  const { healthStatus, restartTerminal } = useTerminalStore(
    useShallow((state) => {
      const term = state.terminals.find((t) => t.id === targetId)
      return {
        healthStatus: term?.healthStatus || 'running',
        restartTerminal: state.restartTerminal
      }
    })
  )
  const fontSize = useTerminalFontSize()
  const bufferSize = useTerminalBufferSize()
  const isMobileWebShell = useMobileWebShell()
  const hostProjectId = useProjectPaneContext()?.projectId
  const treeProjectPath = useProjectStore(
    (state) => state.projects.find((p) => p.id === (hostProjectId || state.activeProjectId))?.path
  )
  const shortcuts = useKeyboardShortcutsStore((state) => state.shortcuts)
  const terminalChannel = useConnectionStatusStore((state) => state.terminalChannel)
  const [sessionLost, setSessionLost] = useState(false)
  const [screen, setScreen] = useState<TerminalScreen | null>(null)
  const [assistPanel, setAssistPanel] = useState<TerminalAssistPanelState | null>(null)
  const { renderer } = useGpuix()
  const hostRef = useRef<PublicInstance | null>(null)

  const ptyIdRef = useRef<string | null>(null)
  const spawnInFlightRef = useRef(false)
  const respawnInFlightRef = useRef(false)
  const fittedRef = useRef(false)
  const pendingSpawnRef = useRef<(() => void) | null>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentLineRef = useRef('')
  const lastWriteFailureToastRef = useRef<string | null>(null)
  const [activity] = useState(createTerminalActivity)
  const latest = useRef({
    onExit,
    onError,
    onSpawned,
    onCommand,
    onBoundToStoreTerminal,
    spawnOptions,
    initialScrollback,
    initialModes,
    shortcuts,
    treeProjectPath
  })
  latest.current = {
    onExit,
    onError,
    onSpawned,
    onCommand,
    onBoundToStoreTerminal,
    spawnOptions,
    initialScrollback,
    initialModes,
    shortcuts,
    treeProjectPath
  }
  const continuityProjectIdRef = useRef(getInstrumentationProjectId(spawnOptions))
  const instrumentationProjectId = getInstrumentationProjectId(spawnOptions)
  useEffect(() => {
    if (instrumentationProjectId) continuityProjectIdRef.current = instrumentationProjectId
  }, [instrumentationProjectId])

  const reportWriteFailure = useCallback((code: string | undefined, message: string): void => {
    const key = code ?? 'UNKNOWN_ERROR'
    if (lastWriteFailureToastRef.current !== key) {
      lastWriteFailureToastRef.current = key
      if (!isTauriContext()) toast.error(message)
      void logFrontendError({
        level: 'warn',
        source: 'ConnectedTerminal.reportWriteFailure',
        message: `terminal write failed (${key}) — user notified (dedup episode started)`
      })
    }
    latest.current.onError?.(message)
  }, [])

  useEffect(() => {
    if (terminalChannel === 'connected') lastWriteFailureToastRef.current = null
  }, [terminalChannel])

  useEffect(
    () =>
      onWebTerminalSessionLost((lostPtyId) => {
        const storePtyId = targetId
          ? useTerminalStore.getState().terminals.find((t) => t.id === targetId)?.ptyId
          : undefined
        if (lostPtyId !== (ptyIdRef.current || storePtyId)) return
        setSessionLost(true)
        if (targetId) useTerminalStore.getState().setTerminalHealthStatus(targetId, 'disconnected')
      }),
    [targetId]
  )

  const writeToPty = useCallback(
    async (data: string): Promise<void> => {
      const ptyId = ptyIdRef.current
      if (!ptyId) return
      try {
        const result = await terminalApi.write(ptyId, data)
        if (!result.success) reportWriteFailure(result.code, result.error)
        else if (useConnectionStatusStore.getState().terminalChannel === 'connected')
          lastWriteFailureToastRef.current = null
      } catch (err) {
        reportWriteFailure(undefined, err instanceof Error ? err.message : 'Write failed')
      }
    },
    [reportWriteFailure]
  )

  /** Typed and reply bytes to the PTY, tracking the command line for history like the DOM view. */
  const handleTerminalData = useCallback(
    (data: string): void => {
      if (data === '\r' || data === '\n') {
        const command = currentLineRef.current
        currentLineRef.current = ''
        if (command) latest.current.onCommand?.(command)
      } else if (data === '\x7f' || data === '\b') {
        currentLineRef.current = currentLineRef.current.slice(0, -1)
      } else if (data === '\x03') {
        currentLineRef.current = ''
      } else if ((data.length === 1 && data.charCodeAt(0) >= 32) || data.length > 1) {
        currentLineRef.current += data
      }
      void writeToPty(data)
    },
    [writeToPty]
  )

  useEffect(() => {
    if (externalTerminalId) ptyIdRef.current = externalTerminalId
  }, [externalTerminalId])

  useEffect(() => {
    if (!externalTerminalId || isTerminalPendingPtyAssignment(externalTerminalId)) return
    useTerminalStore.getState().setRendererAttached(externalTerminalId, true)
    return () => useTerminalStore.getState().setRendererAttached(externalTerminalId, false)
  }, [externalTerminalId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: one screen per bound PTY; props are read through `latest`
  useEffect(() => {
    let current = true
    const cachedFacade = externalTerminalId ? takeCachedTerminal(externalTerminalId) : undefined
    const cached = screenOf(cachedFacade)
    const theme = getActiveTerminalTheme()
    const next = cached ?? new TerminalScreen({ cols: 80, rows: 24, theme, scrollback: bufferSize })
    if (cached) cached.setTheme(theme)
    const xterm = asXterm(next)
    fittedRef.current = cached !== undefined
    setScreen(next)
    log.info(
      'terminal',
      `view.mount ${JSON.stringify({ cached: !!cached, external: !!externalTerminalId })}`
    )

    const replies = next.terminal.onData(handleTerminalData)
    let recordId: string | null = null
    const offData = terminalApi.onData((id: string, data: Uint8Array) => {
      if (id !== ptyIdRef.current) return
      next.write(data)
      recordId ??= useTerminalStore.getState().findTerminalByPtyId(id)?.id ?? null
      if (recordId) activity.note(recordId)
    })
    const offExit = terminalApi.onExit((id: string, exitCode: number, signal?: number) => {
      if (id === ptyIdRef.current) latest.current.onExit?.(exitCode, signal)
    })

    const bind = () =>
      void bindSession({
        screen: next,
        xterm,
        cached: cached !== undefined,
        externalTerminalId,
        storeTerminalId,
        autoSpawn,
        spawnOptions: latest.current.spawnOptions,
        initialScrollback: latest.current.initialScrollback,
        initialModes: latest.current.initialModes,
        continuityProjectId: () => continuityProjectIdRef.current,
        isCurrent: () => current,
        busy: () => spawnInFlightRef.current || ptyIdRef.current !== null,
        setSpawning: (spawning) => {
          spawnInFlightRef.current = spawning
        },
        bindPty: (ptyId) => {
          ptyIdRef.current = ptyId
          if (fittedRef.current)
            void terminalApi.resize(ptyId, next.cols, next.rows).catch(() => {})
        },
        onSpawned: (ptyId) => latest.current.onSpawned?.(ptyId),
        onBound: (ptyId) => latest.current.onBoundToStoreTerminal?.(ptyId),
        onError: (message) => latest.current.onError?.(message)
      })
    let spawnWait: ReturnType<typeof setTimeout> | null = null
    if (externalTerminalId || fittedRef.current) bind()
    else {
      // Spawn at the fitted size, like the DOM view's fit-before-spawn.
      pendingSpawnRef.current = bind
      spawnWait = setTimeout(() => {
        pendingSpawnRef.current = null
        bind()
      }, SPAWN_FIT_WAIT_MS)
    }

    return () => {
      current = false
      if (spawnWait) clearTimeout(spawnWait)
      pendingSpawnRef.current = null
      const ptyId = ptyIdRef.current || externalTerminalId
      if (ptyId) {
        captureScrollPosition(ptyId)
        useTerminalStore.getState().setRendererAttached(ptyId, false)
        unregisterTerminal(ptyId)
      }
      replies.dispose()
      offData()
      offExit()
      activity.clear(activityTerminalId(ptyIdRef.current, targetId))
      // PTY lifecycle belongs to explicit close, never to unmount: a live PTY keeps its screen.
      if (ptyId && useTerminalStore.getState().findTerminalByPtyId(ptyId))
        cacheTerminal(ptyId, xterm)
      else next.dispose()
      log.info('terminal', `view.unmount ${JSON.stringify({ cached: !!ptyId })}`)
      ptyIdRef.current = null
      spawnInFlightRef.current = false
      setScreen(null)
    }
  }, [externalTerminalId, targetId, autoSpawn])

  const onResize = useCallback((cols: number, rows: number) => {
    fittedRef.current = true
    const spawn = pendingSpawnRef.current
    if (spawn) {
      pendingSpawnRef.current = null
      spawn()
      return
    }
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
    resizeTimerRef.current = setTimeout(() => {
      resizeTimerRef.current = null
      const ptyId = ptyIdRef.current
      if (ptyId) void terminalApi.resize(ptyId, cols, rows).catch(() => {})
    }, PTY_RESIZE_DEBOUNCE_MS)
  }, [])

  const focusTerminal = useCallback(() => {
    if (hostRef.current) renderer?.focusElement?.(hostRef.current.id)
  }, [renderer])

  useEffect(() => {
    if (!isVisible || !screen) return
    const focused = renderer?.getFocusedElementId?.()
    if (autoFocus && (focused === null || focused === undefined)) focusTerminal()
  }, [isVisible, screen, autoFocus, focusTerminal, renderer])

  const xterm = useMemo(() => (screen ? asXterm(screen) : null), [screen])
  const { copySelection, pasteFromClipboard, hasSelection } = useTerminalClipboard({
    terminal: xterm,
    pasteText: writeToPty
  })

  const onKeyIntercept = useCallback(
    (event: KeyEvent): boolean => {
      const dom = windowKeyEvent('keydown', event) as KeyboardEvent
      if (isAppOwnedTerminalShortcut(dom, latest.current.shortcuts)) {
        // macOS keeps Ctrl+key for the shell; the app owns the ⌘ chords.
        return !(isMac && dom.ctrlKey && !dom.metaKey)
      }
      // Shift+Enter sends LF so multiline TUIs (Claude Code, Ink) can tell it from Enter.
      if (dom.key === 'Enter' && dom.shiftKey && !dom.ctrlKey && !dom.metaKey && !dom.altKey) {
        event.preventDefault()
        handleTerminalData('\n')
        return true
      }
      return false
    },
    [handleTerminalData]
  )

  const onLinkClick = useCallback(
    (point: { row: number; col: number }): boolean => {
      if (!screen) return false
      const line = screen.terminal.buffer.active.getLine(point.row)?.translateToString(true) ?? ''
      const link = linkAt(line, point.col)
      if (!link) return false
      log.info('terminal', `link.activate ${JSON.stringify({ kind: link.kind })}`)
      if (link.kind === 'url') {
        if (!isSupportedTerminalUrl(link.text)) {
          toast.error('Only http/https URLs are supported from terminal output.')
          return true
        }
        openTerminalUrl(link.text).catch(() =>
          toast.error('Failed to open URL from terminal output.')
        )
        return true
      }
      openFilePathFromTerminal(link.text, {
        cwd: useTerminalStore.getState().findTerminalByPtyId(ptyIdRef.current || '')?.cwd,
        projectRoot: latest.current.treeProjectPath
      })
        .then((result) => {
          if (!result.ok) toast.error(result.message)
        })
        .catch(() => toast.error('Failed to open file from terminal output.'))
      return true
    },
    [screen]
  )

  const runTerminalAssist = useCallback(
    async (kind: 'explain' | 'fix') => {
      const selection = screen?.selectedText().trim() ?? ''
      const record = ptyIdRef.current
        ? useTerminalStore.getState().findTerminalByPtyId(ptyIdRef.current)
        : undefined
      if (!selection || !record?.cwd) {
        setAssistPanel({ kind, status: 'error', error: 'Select some terminal output first' })
        return
      }
      setAssistPanel({ kind, status: 'loading' })
      try {
        const text = await useAcpStore
          .getState()
          .assistTerminal(kind, record.cwd, selection, record.lastExitCode ?? null)
        setAssistPanel((prev) => (prev ? { kind, status: 'done', text } : prev))
      } catch (error) {
        setAssistPanel((prev) => (prev ? { kind, status: 'error', error: String(error) } : prev))
      }
    },
    [screen]
  )

  // #259: insertion only, never executed; control characters are refused outright.
  const insertAssistCommand = useCallback(async (command: string) => {
    const ptyId = ptyIdRef.current
    if (!ptyId) return
    for (const ch of command) {
      const code = ch.charCodeAt(0)
      if (code < 0x20 || code === 0x7f) {
        latest.current.onError?.('Refused to insert a command containing control characters')
        return
      }
    }
    try {
      const result = await terminalApi.write(ptyId, command)
      if (!result.success) latest.current.onError?.(result.error)
    } catch (err) {
      latest.current.onError?.(err instanceof Error ? err.message : 'Insert failed')
    }
  }, [])

  useImperativeHandle(
    searchRef,
    () => ({
      findNext: (term: string) => screen?.find(term) ?? false,
      findPrevious: (term: string) => screen?.find(term, true) ?? false,
      clearDecorations: () => screen?.setSelection(null),
      writeText: (text: string) => {
        if (ptyIdRef.current) void terminalApi.write(ptyIdRef.current, text)
      }
    }),
    [screen]
  )

  const respawnAfterSessionLoss = useCallback(async (): Promise<void> => {
    if (!screen || respawnInFlightRef.current) return
    respawnInFlightRef.current = true
    try {
      const options = latest.current.spawnOptions
      const result = await terminalApi.spawn({
        ...options,
        shell: options?.shell || undefined,
        cols: screen.cols || 80,
        rows: screen.rows || 24
      })
      if (!result.success) {
        toast.error(result.error || 'Failed to restart the terminal session')
        void logFrontendError({
          level: 'warn',
          source: 'ConnectedTerminal.respawnAfterSessionLoss',
          message: `session restart spawn failed (${result.code ?? 'UNKNOWN'})`
        })
        return
      }
      const newPtyId = result.data.id
      ptyIdRef.current = newPtyId
      registerTerminal(newPtyId, asXterm(screen))
      useTerminalStore.getState().setRendererAttached(newPtyId, true)
      if (result.data.claim)
        useTerminalStore.getState().setTerminalClaim(newPtyId, result.data.claim)
      if (targetId) {
        const store = useTerminalStore.getState()
        const record = store.terminals.find((t) => t.id === targetId)
        if (record?.ptyId) store.clearTerminalPtyId(record.ptyId)
        store.setTerminalPtyId(targetId, newPtyId)
        store.setTerminalHealthStatus(targetId, 'running')
        latest.current.onBoundToStoreTerminal?.(newPtyId)
      }
      screen.write(
        '\r\n\x1b[33m[server restarted — new session started; previous output is history]\x1b[0m\r\n'
      )
      setSessionLost(false)
      focusTerminal()
    } finally {
      respawnInFlightRef.current = false
    }
  }, [screen, targetId, focusTerminal])

  const isCrashed = healthStatus === 'disconnected' || healthStatus === 'crashed'
  const padding = isMobileWebShell ? 'px-1.5' : 'px-4'

  return (
    <ContextMenu>
      <div style={tw('relative flex h-full w-full overflow-hidden')}>
        <div
          style={tw(
            `flex h-full w-full flex-col ${isVisible ? 'bg-terminal-bg' : ''} py-0.5 pb-1 ${padding} ${className}`
          )}
        >
          {screen ? (
            <ContextMenuTrigger asChild>
              <TerminalHost
                ref={hostRef}
                screen={screen}
                onInput={handleTerminalData}
                onResize={onResize}
                visible={isVisible}
                autoFocus={autoFocus && isVisible}
                fontSize={fontSize}
                cursorBlink={DEFAULT_TERMINAL_OPTIONS.cursorBlink}
                cursorStyle={DEFAULT_TERMINAL_OPTIONS.cursorStyle}
                onKeyIntercept={onKeyIntercept}
                onCopy={() => void copySelection()}
                onPaste={() => void pasteFromClipboard()}
                onLinkClick={onLinkClick}
                testId={`terminal-${targetId ?? 'new'}`}
              />
            </ContextMenuTrigger>
          ) : null}
        </div>
        {isCrashed && (
          <SessionOverlay
            tone="destructive"
            badge="Critical error"
            eyebrow="Terminal pane exception"
            title="Session Interrupted"
            body="The terminal process exited unexpectedly. This usually happens if the shell crashes or the PTY is killed by the OS."
            action="Reconnect Session"
            reference={targetId}
            onAction={() => {
              if (targetId) restartTerminal(targetId)
            }}
          />
        )}
        {!isCrashed && sessionLost && (
          <SessionOverlay
            tone="warning"
            badge="Session ended"
            eyebrow="Server restarted"
            title="server restarted — session ended"
            body="The terminal server was restarted, so this shell no longer exists. The connection is back and re-authenticated; start a fresh shell to continue. Input was not delivered."
            action="Restart"
            reference={targetId}
            onAction={() => void respawnAfterSessionLoss()}
          />
        )}
        {assistPanel ? (
          <TerminalAssistPanel
            state={assistPanel}
            onClose={() => setAssistPanel(null)}
            onInsertCommand={(command) => void insertAssistCommand(command)}
          />
        ) : null}
        {!isCrashed && !isTauriContext() && terminalChannel !== 'connected' && (
          <div
            role="status"
            style={{
              ...tw(
                'absolute right-2 top-2 z-20 flex flex-row items-center gap-1.5 rounded-full border border-border/60 bg-background/80 px-2 py-1 text-xs text-muted-foreground shadow-sm'
              ),
              pointerEvents: 'none'
            }}
          >
            <AgentConnectionLamp
              connected={false}
              reconnecting={
                terminalChannel !== 'disconnected' && terminalChannel !== 'host-offline'
              }
              hostOffline={terminalChannel === 'host-offline'}
              decorative
              size={8}
            />
            <text>
              {channelLabel(
                terminalChannel,
                !!ptyIdRef.current && isWebTerminalBufferable(ptyIdRef.current)
              )}
            </text>
          </div>
        )}
      </div>
      <ContextMenuContent className="w-40">
        <ContextMenuItem onSelect={() => void copySelection()} disabled={!hasSelection}>
          Copy <ContextMenuShortcut>{SHORTCUT_MOD}+C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void pasteFromClipboard()}>
          Paste <ContextMenuShortcut>{SHORTCUT_MOD}+V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => screen?.selectAll()}>
          Select All <ContextMenuShortcut>{SHORTCUT_MOD}+A</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => void runTerminalAssist('explain')}
          disabled={!hasSelection}
        >
          Explain with AI
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void runTerminalAssist('fix')} disabled={!hasSelection}>
          Fix Command with AI
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => {
            if (targetId) restartTerminal(targetId)
          }}
          className="text-primary focus:text-primary"
        >
          <RefreshCcw size={14} className="mr-2" /> Restart Terminal
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export const ConnectedTerminal = memo(ConnectedTerminalComponent)
