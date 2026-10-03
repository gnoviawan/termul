import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import type { IDisposable } from '@xterm/xterm'
import { Terminal } from '@xterm/xterm'
import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, RefreshCcw } from '@/components/icons'
import { Button } from '@/components/ui/button'
import '@xterm/xterm/css/xterm.css'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useShallow } from 'zustand/shallow'
import { AgentConnectionLamp } from '@/components/chat/AgentConnectionLamp'
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
import { useTerminalColorTheme } from '@/hooks/use-terminal-color-theme'
import { useTerminalResizeV2 } from '@/hooks/use-terminal-resize-v2'
import { isTerminalPendingPtyAssignment } from '@/hooks/use-terminal-restore'
import { terminalApi } from '@/lib/api'
import { openTerminalUrl } from '@/lib/browser/terminal-url-navigation'
import { buildTerminalPathLinks, openFilePathFromTerminal } from '@/lib/file-path-links'
import { logFrontendError } from '@/lib/log-api'
import { isMac } from '@/lib/platform'
import { isTauriContext } from '@/lib/tauri-runtime'
import { addRendererRef, removeRendererRef } from '@/lib/tauri-terminal-api'
import {
  getOrCreateProjectContinuityCorrelation,
  recordTerminalContinuityEvent
} from '@/lib/terminal-continuity-instrumentation'
import { buildTerminalUrlLinks, isSupportedTerminalUrl } from '@/lib/terminal-url-links'
import { applyThemeToTerminal, getActiveTerminalTheme } from '@/lib/themes'
import { getTerminalSearchDecorations } from '@/lib/themes/terminal-search-decorations'
import { isWebTerminalBufferable } from '@/lib/web-terminal-api'
import { useAcpStore } from '@/stores/acp-store'
import {
  useTerminalBufferSize,
  useTerminalFontFamily,
  useTerminalFontSize,
  useTerminalRenderer
} from '@/stores/app-settings-store'
import { useConnectionStatusStore } from '@/stores/connection-status-store'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { useActiveProject } from '@/stores/project-store'
import { useTerminalStore } from '@/stores/terminal-store'
import type { TerminalModes, TerminalSpawnOptions } from '../../../shared/types/ipc.types'
import {
  buildRehydrateSequences,
  captureScrollPosition,
  registerTerminal,
  restoreScrollback,
  restoreScrollPosition,
  unregisterTerminal
} from '../../utils/terminal-registry'
import { handleTerminalClipboardKey } from './clipboard'
import { getInstrumentationProjectId, PARTIAL_RESTORE_NOTE } from './instrumentation'
import { isAppOwnedTerminalShortcut, SHORTCUT_MOD, trapTerminalTabFocusNavigation } from './keymap'
import { TerminalAssistPanel, type TerminalAssistPanelState } from './TerminalAssistPanel'
import { cacheTerminal, takeCachedTerminal } from './terminal-cache'
import { getTerminalOptions } from './terminal-config'
import { useTerminalFit } from './use-terminal-fit'
import {
  describeWebglContext,
  getDevicePixelRatio,
  MAX_WEBGL_RECOVERY_ATTEMPTS,
  resyncWebglDimensions,
  shouldUseWebglRenderer,
  useWebglRecovery,
  WEBGL_CONTEXT_LOSS_RECOVERY_DELAY_MS
} from './use-webgl-recovery'

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
  /**
   * R3: captured DEC private-mode snapshot to replay before `initialScrollback`
   * on terminal mount, so an alt-screen TUI (vim/tmux/less) restores its
   * screen/modes. Optional — absence degrades to content-only restore.
   */
  initialModes?: TerminalModes | null
  searchRef?: React.Ref<TerminalSearchHandle>
  isVisible?: boolean
}

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
  // 1. STABLE ID DERIVATION
  const targetId = storeTerminalId || externalTerminalId

  // 2. STORE HOOKS (Must be at the top)
  const { healthStatus, restartTerminal } = useTerminalStore(
    useShallow((state) => {
      const term = state.terminals.find((t) => t.id === targetId)
      return {
        healthStatus: term?.healthStatus || 'running',
        restartTerminal: state.restartTerminal
      }
    })
  )

  const fontFamily = useTerminalFontFamily()
  const fontSize = useTerminalFontSize()
  const bufferSize = useTerminalBufferSize()
  const rendererPreference = useTerminalRenderer()
  // Story 2 mobile stopgap: on the mobile web shell (browser, viewport
  // <= MOBILE_WEB_SHELL_MAX_PX) the 'auto' renderer default resolves to the
  // DOM renderer — WebGL paints zero pixels at DPR >= 3 (QA repro). Explicit
  // 'webgl'/'dom' is honored verbatim; desktop is unchanged ('auto' → WebGL).
  const isMobileWebShell = useMobileWebShell()
  const effectiveRendererPreference: 'auto' | 'webgl' | 'dom' =
    isMobileWebShell && rendererPreference === 'auto' ? 'dom' : rendererPreference
  const activeProject = useActiveProject()
  const shortcuts = useKeyboardShortcutsStore((state) => state.shortcuts)
  // Story 10 (F1/F10): terminal-channel health — drives the non-blocking
  // reconnect/disconnected overlay. Stays 'connected' on Tauri desktop (the
  // store is web-only), so desktop rendering is unchanged.
  const terminalChannel = useConnectionStatusStore((state) => state.terminalChannel)

  // 3. REFS
  const instanceIdRef = useRef<string>(`conn-${Math.random().toString(36).slice(2, 9)}`)
  const instanceId = instanceIdRef.current
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const webglAddonRef = useRef<WebglAddon | null>(null)
  const fileLinkProviderDisposableRef = useRef<IDisposable | null>(null)
  // Track visibility prop for recovery path guards (tab-active, not window-visible).
  // Ref avoids stale closures in event listeners referencing isVisible directly.
  const isVisibleRef = useRef(isVisible)
  isVisibleRef.current = isVisible
  // Story 2: the ref tracks the EFFECTIVE preference (mobile 'auto'→'dom'
  // flip applied), so every guard — init, addon load, recovery, visibility
  // restore — honors the mobile stopgap without per-site changes.
  const rendererPreferenceRef = useRef(effectiveRendererPreference)
  rendererPreferenceRef.current = effectiveRendererPreference
  // Story 2: mobile-shell flag ref so event-listener closures (init,
  // recovery, visibility restore) read fresh state without re-subscribing.
  const isMobileWebShellRef = useRef(isMobileWebShell)
  isMobileWebShellRef.current = isMobileWebShell
  const activeProjectPathRef = useRef<string | undefined>(activeProject?.path)
  activeProjectPathRef.current = activeProject?.path
  const shortcutsRef = useRef(shortcuts)
  shortcutsRef.current = shortcuts
  const cleanupDataListenerRef = useRef<(() => void) | null>(null)
  const cleanupExitListenerRef = useRef<(() => void) | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const spawnInFlightRef = useRef(false)
  const didInitRef = useRef(false)
  const initializedTerminalIdRef = useRef<string | undefined>(undefined)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const onSpawnedRef = useRef(onSpawned)
  onSpawnedRef.current = onSpawned
  const onCommandRef = useRef(onCommand)
  onCommandRef.current = onCommand
  const onBoundToStoreTerminalRef = useRef(onBoundToStoreTerminal)
  onBoundToStoreTerminalRef.current = onBoundToStoreTerminal
  const spawnOptionsRef = useRef(spawnOptions)
  spawnOptionsRef.current = spawnOptions
  const initialScrollbackRef = useRef(initialScrollback)
  initialScrollbackRef.current = initialScrollback
  // R3: keep the latest captured modes in a ref so the second init path
  // (window-recovery spawnTerminal) reads the current value.
  const initialModesRef = useRef(initialModes)
  initialModesRef.current = initialModes
  const currentLineRef = useRef<string>('')
  const continuityProjectIdRef = useRef<string | undefined>(
    getInstrumentationProjectId(spawnOptions)
  )
  const lastClipboardOpRef = useRef<number>(0)
  // Story 10: write-failure toasts are deduped by error code within one
  // outage episode (a held key would otherwise spam one toast per
  // keystroke). Reset on the next successful write or channel recovery.
  const lastWriteFailureToastRef = useRef<string | null>(null)
  // Story 10 (F10): surface write failures visibly — a toast deduped by
  // error code (one per outage episode, reset on the next DELIVERED write —
  // a buffered offline write's local success does not reset the episode — or
  // on channel recovery) so a held key can't spam. Web-only: on Tauri the
  // write path is direct IPC and keeps its pre-existing behavior (the
  // `onError` callback still fires there — only the toast is web-scoped).
  const reportWriteFailure = useCallback((code: string | undefined, message: string): void => {
    const key = code ?? 'UNKNOWN_ERROR'
    if (lastWriteFailureToastRef.current !== key) {
      lastWriteFailureToastRef.current = key
      if (!isTauriContext()) toast.error(message)
      // Durable failure log per DEDUP EPISODE (not per keystroke) — mirrors
      // the toast cadence. Metadata only: error code, never the input.
      void logFrontendError({
        level: 'warn',
        source: 'ConnectedTerminal.reportWriteFailure',
        message: `terminal write failed (${key}) — user notified (dedup episode started)`
      })
    }
    onErrorRef.current?.(message)
  }, [])

  // Story 10: channel recovery starts a new episode — the next failure
  // toasts again.
  useEffect(() => {
    if (terminalChannel === 'connected') lastWriteFailureToastRef.current = null
  }, [terminalChannel])

  // Two-stage resize pipeline: 8ms fit debounce + 256ms PTY resize debounce
  const handlePtyResize = useCallback(async (cols: number, rows: number): Promise<void> => {
    const ptyId = ptyIdRef.current
    if (!ptyId) return
    try {
      await terminalApi.resize(ptyId, cols, rows)
    } catch {
      // Ignore resize errors during rapid resize
    }
  }, [])

  const { forceFit: forceResizeFit } = useTerminalResizeV2({
    onPtyResize: handlePtyResize,
    terminalRef,
    fitAddonRef,
    containerRef,
    isVisible
  })

  const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(null)
  // Inline terminal AI assist (#259): null = hidden panel.
  const [assistPanel, setAssistPanel] = useState<TerminalAssistPanelState | null>(null)
  useTerminalColorTheme(terminalInstance)

  // 5. CALLBACKS & EFFECTS
  const { copySelection, pasteFromClipboard, hasSelection } = useTerminalClipboard({
    terminal: terminalInstance,
    pasteText: async (text: string) => {
      const ptyId = ptyIdRef.current
      if (!ptyId) return
      try {
        const result = await terminalApi.write(ptyId, text)
        if (!result.success) {
          reportWriteFailure(result.code, result.error)
        } else if (useConnectionStatusStore.getState().terminalChannel === 'connected') {
          // Reset the toast episode only on a write the server could actually
          // have received — a buffered offline write's local success must not
          // start a new dedup episode (the outage is still in progress).
          lastWriteFailureToastRef.current = null
        }
      } catch (err) {
        reportWriteFailure(undefined, err instanceof Error ? err.message : 'Paste write failed')
      }
    },
    onImagePaste: async () => {
      const ptyId = ptyIdRef.current
      if (!ptyId) return
      // Send Ctrl+V byte to PTY - CLI apps like OpenCode read the OS clipboard directly
      try {
        const result = await terminalApi.write(ptyId, '\x16')
        if (!result.success) {
          reportWriteFailure(result.code, result.error)
        }
      } catch (err) {
        reportWriteFailure(undefined, err instanceof Error ? err.message : 'Image paste failed')
      }
    }
  })
  const copySelectionRef = useRef(copySelection)
  copySelectionRef.current = copySelection

  // #259: inline terminal AI assist — runs against the user's configured
  // agent in a hidden one-shot ACP session (see acp-store.assistTerminal).
  const runTerminalAssist = useCallback(
    async (kind: 'explain' | 'fix') => {
      const selection = terminalInstance?.getSelection()?.trim() ?? ''
      const record = ptyIdRef.current
        ? useTerminalStore.getState().findTerminalByPtyId(ptyIdRef.current)
        : undefined
      if (!selection || !record?.cwd) {
        setAssistPanel({
          kind,
          status: 'error',
          error: 'Select some terminal output first'
        })
        return
      }
      setAssistPanel({ kind, status: 'loading' })
      try {
        const text = await useAcpStore
          .getState()
          .assistTerminal(kind, record.cwd, selection, record.lastExitCode ?? null)
        // Functional update: if the user closed the panel while the request
        // was in flight, the settled response must not reopen it (#689
        // review).
        setAssistPanel((prev) => (prev ? { kind, status: 'done', text } : prev))
      } catch (error) {
        setAssistPanel((prev) => (prev ? { kind, status: 'error', error: String(error) } : prev))
      }
    },
    [terminalInstance]
  )

  // #259: insertion only — the suggested command lands at the prompt for
  // review and is never executed automatically (no trailing newline).
  // Defense in depth: anything carrying a newline/control character is
  // refused outright — `terminalApi.write` feeds the PTY directly.
  const insertAssistCommand = useCallback(async (command: string) => {
    const ptyId = ptyIdRef.current
    if (!ptyId) return
    for (const ch of command) {
      const code = ch.charCodeAt(0)
      if (code < 0x20 || code === 0x7f) {
        if (onErrorRef.current) {
          onErrorRef.current('Refused to insert a command containing control characters')
        }
        return
      }
    }
    try {
      const result = await terminalApi.write(ptyId, command)
      if (!result.success && onErrorRef.current) {
        onErrorRef.current(result.error)
      }
    } catch (err) {
      if (onErrorRef.current) {
        onErrorRef.current(err instanceof Error ? err.message : 'Insert failed')
      }
    }
  }, [])
  const pasteFromClipboardRef = useRef(pasteFromClipboard)
  pasteFromClipboardRef.current = pasteFromClipboard

  useEffect(() => {
    if (externalTerminalId) ptyIdRef.current = externalTerminalId
  }, [externalTerminalId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on spawnOptions change but read latest via ref
  useEffect(() => {
    if (continuityProjectIdRef.current)
      continuityProjectIdRef.current = getInstrumentationProjectId(spawnOptionsRef.current)
  }, [spawnOptions])

  useEffect(() => {
    if (!externalTerminalId || isTerminalPendingPtyAssignment(externalTerminalId)) return
    useTerminalStore.getState().setRendererAttached(externalTerminalId, true)
    return () => {
      useTerminalStore.getState().setRendererAttached(externalTerminalId, false)
    }
  }, [externalTerminalId])

  const instrumentationProjectId = getInstrumentationProjectId(spawnOptions)

  useEffect(() => {
    if (instrumentationProjectId) {
      continuityProjectIdRef.current = instrumentationProjectId
    }
  }, [instrumentationProjectId])

  // Memoize spawn options to prevent unnecessary re-spawns
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps intentionally track specific spawnOptions fields
  const memoizedSpawnOptions = useMemo(
    () => spawnOptions,
    [
      spawnOptions?.shell,
      spawnOptions?.cwd,
      spawnOptions?.cols,
      spawnOptions?.rows,
      spawnOptions?.env
    ]
  )

  // Handle input from xterm to PTY
  const handleTerminalData = useCallback(
    async (data: string): Promise<void> => {
      const ptyId = ptyIdRef.current
      if (!ptyId) return

      // Track command input for history
      if (data === '\r' || data === '\n') {
        // Enter pressed - capture command
        const command = currentLineRef.current
        currentLineRef.current = ''
        if (command && onCommandRef.current) {
          onCommandRef.current(command)
        }
      } else if (data === '\x7f' || data === '\b') {
        // Backspace
        currentLineRef.current = currentLineRef.current.slice(0, -1)
      } else if (data === '\x03') {
        // Ctrl+C - clear current line
        currentLineRef.current = ''
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        // Printable character
        currentLineRef.current += data
      } else if (data.length > 1) {
        // Pasted text
        currentLineRef.current += data
      }

      try {
        const result = await terminalApi.write(ptyId, data)
        if (!result.success) {
          reportWriteFailure(result.code, result.error)
        } else if (useConnectionStatusStore.getState().terminalChannel === 'connected') {
          lastWriteFailureToastRef.current = null
        }
      } catch (err) {
        reportWriteFailure(undefined, err instanceof Error ? err.message : 'Write failed')
      }
    },
    [reportWriteFailure]
  )

  // Initialize terminal, set up IPC listeners, and spawn PTY
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally narrow deps; a full list would recreate the terminal instance on every render
  useEffect(() => {
    const debugId = `${instanceId}-${Date.now().toString().slice(-6)}`

    devLog(`[ConnectedTerminal] MOUNT [${debugId}]`, {
      instanceId,
      externalTerminalId,
      autoSpawn,
      spawnOptions,
      isVisible
    })

    if (!containerRef.current) {
      devLog(`[ConnectedTerminal] SKIP [${debugId}]: no container`)
      return
    }

    // Check if we're initializing a new terminal (different from previous)
    const terminalKey = externalTerminalId ?? 'new'
    devLog(`[ConnectedTerminal] terminalKey check [${debugId}]`, {
      terminalKey,
      didInit: didInitRef.current,
      initializedKey: initializedTerminalIdRef.current,
      willSkip: didInitRef.current && initializedTerminalIdRef.current === terminalKey
    })

    if (didInitRef.current && initializedTerminalIdRef.current === terminalKey) {
      devLog(`[ConnectedTerminal] SKIP [${debugId}]: already initialized for ${terminalKey}`)
      return
    }

    // Reset init state for new terminal
    didInitRef.current = true
    initializedTerminalIdRef.current = terminalKey

    devLog(`[ConnectedTerminal] INITIALIZING [${debugId}] for key: ${terminalKey}`)

    // Merge platform-aware options with dynamic app settings
    const terminalOptions = {
      ...getTerminalOptions(navigator.platform),
      fontFamily,
      fontSize,
      scrollback: bufferSize
    }

    // Check for a cached terminal preserved across project switches.
    // If found, reuse it (preserves scrollback, alt buffer, cursor, etc.)
    // and skip both terminal.open() and transcript replay.
    const cacheKey = externalTerminalId || undefined
    const cachedTerminal = cacheKey ? takeCachedTerminal(cacheKey) : undefined

    let terminal: Terminal
    if (cachedTerminal) {
      devLog(`[ConnectedTerminal] RESTORED cached terminal`, {
        cacheKey
      })
      terminal = cachedTerminal
      applyThemeToTerminal(terminal, getActiveTerminalTheme())
    } else {
      terminal = new Terminal(terminalOptions)
    }
    terminalRef.current = terminal
    setTerminalInstance(terminal)

    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    terminal.loadAddon(fitAddon)

    const handleFilePathActivate = async (event: MouseEvent, uri: string): Promise<void> => {
      if (!event.ctrlKey && !event.metaKey) {
        return
      }

      event.preventDefault()

      try {
        const result = await openFilePathFromTerminal(uri, {
          cwd: useTerminalStore.getState().findTerminalByPtyId(ptyIdRef.current || '')?.cwd,
          projectRoot: activeProjectPathRef.current
        })

        if (!result.ok) {
          toast.error(result.message)
        }
      } catch (error) {
        console.error('[Terminal File Link Open Failed]', error)
        toast.error('Failed to open file from terminal output.')
      }
    }

    const handleUrlActivate = async (event: MouseEvent, url: string): Promise<void> => {
      if (!event.ctrlKey && !event.metaKey) {
        return
      }

      event.preventDefault()

      if (!isSupportedTerminalUrl(url)) {
        toast.error('Only http/https URLs are supported from terminal output.')
        return
      }

      try {
        await openTerminalUrl(url)
      } catch (error) {
        console.error('[Terminal URL Link Open Failed]', error)
        toast.error('Failed to open URL from terminal output.')
      }
    }

    fileLinkProviderDisposableRef.current = terminal.registerLinkProvider({
      provideLinks(y, callback) {
        const line = terminal.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
        const pathLinks = buildTerminalPathLinks(line, y, handleFilePathActivate)
        const urlLinks = buildTerminalUrlLinks(line, y, handleUrlActivate)
        callback([...urlLinks, ...pathLinks])
      }
    })

    // Load search addon
    const searchAddon = new SearchAddon()
    searchAddonRef.current = searchAddon
    terminal.loadAddon(searchAddon)

    if (cachedTerminal) {
      // Reattach the preserved xterm element to the new container.
      // This avoids losing scrollback, alt-buffer, and cursor state.
      if (containerRef.current && terminal.element) {
        containerRef.current.appendChild(terminal.element)
      }

      // Note: the actual fix for "frozen terminal after rapid project
      // switches" lives in terminal-cache.ts (cacheTerminal disposes any
      // stale prior occupant before storing a new one). The fresh
      // component instance always arrives here with webglAddonRef.current
      // === null (the previous instance disposed its addon during cleanup),
      // so a guarded dispose here would be a no-op. We just reset the
      // context-lost flag so the WebGL addon load further down treats this
      // as a clean mount.
      webglContextLostRef.current = false

      // Force a full refresh so the renderer repaints after DOM reattachment.
      terminal.refresh(0, terminal.rows - 1)
    } else {
      terminal.open(containerRef.current)
    }

    // Intercept keyboard shortcuts before xterm processes them
    // Return false to prevent xterm from handling, true to let xterm handle
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') return true

      const shortcuts = shortcutsRef.current

      // Check if this key matches any app shortcut
      // On macOS: Ctrl+key shortcuts should pass through to the shell (not intercepted by app)
      // Only ⌘+key shortcuts are intercepted by the app on macOS
      if (isAppOwnedTerminalShortcut(event, shortcuts)) {
        // On macOS inside a terminal, don't intercept ctrl+... shortcuts from the app config.
        // These are ctrl-key combos that should go to the shell (e.g., ctrl+r = reverse-i-search).
        // The ⌘ equivalent is handled by the clipboardModifier block above.
        if (isMac && event.ctrlKey && !event.metaKey) {
          // Passthrough: let xterm send the raw ctrl sequence to the shell
          return true
        }

        // Don't call stopPropagation() - let event bubble to window handler
        // Return false to prevent xterm from handling the event
        return false
      }

      // Handle copy/paste/select all keyboard shortcuts
      // macOS convention: ⌘+C/V/A for clipboard operations, Ctrl+C = SIGINT
      // Windows/Linux convention: Ctrl+C/V/A for everything
      const clipboardResult = handleTerminalClipboardKey(event, terminal, lastClipboardOpRef, {
        copySelection,
        pasteFromClipboard,
        copyRequiresNonEmptySelection: true
      })
      if (clipboardResult !== undefined) return clipboardResult

      if (trapTerminalTabFocusNavigation(event)) {
        return true
      }

      // Shift+Enter → newline (LF). xterm.js sends \r for Enter regardless of
      // Shift, so multiline TUI apps (Claude Code, Ink, etc.) can't tell it
      // apart from a plain Enter and treat it as "submit". Send \n (LF) — the
      // same byte Ctrl+J produces — so Shift+Enter inserts a newline instead.
      // Pure Shift+Enter only: ignore it when other modifiers are held (so
      // Cmd/Ctrl+Shift+Enter app shortcuts are unaffected) and during IME
      // composition.
      if (
        event.key === 'Enter' &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.isComposing
      ) {
        event.preventDefault()
        handleTerminalData('\n')
        return false
      }

      return true
    })

    // WebGL addon loading with context loss recovery
    const loadWebglAddon = (term: Terminal, isRecovery: boolean = false): void => {
      if (!shouldUseWebglRenderer(rendererPreferenceRef.current, isMobileWebShellRef.current)) {
        webglAddonRef.current = null
        return
      }
      if (webglAddonRef.current) {
        return
      }
      if (webglRecoveryAttemptsRef.current >= MAX_WEBGL_RECOVERY_ATTEMPTS) {
        console.warn('WebGL recovery attempts exhausted, falling back to DOM renderer')
        recordTerminalContinuityEvent({
          name: 'renderer-recovery-exhausted',
          ptyId: ptyIdRef.current ?? undefined,
          details: {
            attempts: webglRecoveryAttemptsRef.current,
            maxAttempts: MAX_WEBGL_RECOVERY_ATTEMPTS,
            isRecovery
          }
        })
        return
      }
      try {
        recordTerminalContinuityEvent({
          name: 'renderer-recovery-attempted',
          ptyId: ptyIdRef.current ?? undefined,
          details: {
            attempt: webglRecoveryAttemptsRef.current + 1,
            maxAttempts: MAX_WEBGL_RECOVERY_ATTEMPTS,
            isRecovery,
            renderer: 'webgl'
          }
        })
        const webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => {
          webglAddon.dispose()
          webglAddonRef.current = null
          webglDprWatchedRef.current = 0
          // Mark context as lost for recovery decisions
          webglContextLostRef.current = true
          if (!shouldUseWebglRenderer(rendererPreferenceRef.current, isMobileWebShellRef.current)) {
            webglContextLostRef.current = false
            return
          }
          // Increment recovery counter BEFORE scheduling recovery
          webglRecoveryAttemptsRef.current++
          // Clear any pending recovery timeout
          if (webglRecoveryTimeoutRef.current) {
            clearTimeout(webglRecoveryTimeoutRef.current)
          }
          // Delay before recovery to avoid rapid-fire loops
          webglRecoveryTimeoutRef.current = setTimeout(() => {
            webglRecoveryTimeoutRef.current = null
            loadWebglAddon(term, true)
          }, WEBGL_CONTEXT_LOSS_RECOVERY_DELAY_MS)
        })
        term.loadAddon(webglAddon)
        webglAddonRef.current = webglAddon
        // Clear context lost flag on successful load
        webglContextLostRef.current = false
        if (!isRecovery) {
          webglRecoveryAttemptsRef.current = 0
        }
        // Story 3 (P0, blank canvas at DPR >= 3): force a dimensions re-sync
        // at the CURRENT devicePixelRatio after load — see resyncWebglDimensions.
        // A throw degrades to the failure log (log-api), never a crash.
        try {
          resyncWebglDimensions(term)
          webglDprWatchedRef.current = getDevicePixelRatio()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          void logFrontendError({
            level: 'error',
            source: 'ConnectedTerminal.loadWebglAddon',
            message: `WebGL dimensions re-sync failed after addon load: ${message} (${describeWebglContext(term)})`
          })
        }
        recordTerminalContinuityEvent({
          name: 'renderer-recovery-succeeded',
          ptyId: ptyIdRef.current ?? undefined,
          details: {
            attempt: webglRecoveryAttemptsRef.current + 1,
            isRecovery,
            renderer: 'webgl'
          }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.warn('WebGL addon failed to load, falling back to DOM renderer:', error)
        webglAddonRef.current = null
        webglRecoveryAttemptsRef.current++
        recordTerminalContinuityEvent({
          name: 'renderer-recovery-failed',
          ptyId: ptyIdRef.current ?? undefined,
          details: {
            error: message,
            attempt: webglRecoveryAttemptsRef.current,
            isRecovery,
            renderer: 'webgl'
          }
        })
      }
    }

    if (shouldUseWebglRenderer(rendererPreferenceRef.current, isMobileWebShellRef.current)) {
      loadWebglAddon(terminal)
    }
    // Store reference for recovery handlers to use
    loadWebglAddonRef.current = loadWebglAddon

    // Defer initial fit to next animation frame so the WebGL renderer has time
    // to fully initialize its internal _renderer.value before we call dimensions.
    // Calling fit() synchronously after loadWebglAddon() causes an uncaught
    // "Cannot read properties of undefined (reading 'dimensions')" from xterm.
    requestAnimationFrame(() => {
      performFit(true)
    })

    if (autoFocus) {
      terminal.focus()
    }

    // Set up resize observer

    // Listen for input from xterm
    const dataDisposable = terminal.onData(handleTerminalData)

    // Set up IPC listeners BEFORE spawning to avoid missing data
    // Cache ptyId -> terminalId mapping to avoid repeated store lookups
    let cachedTerminalId: string | null = null
    cleanupDataListenerRef.current = terminalApi.onData((id: string, data: Uint8Array) => {
      if (id === ptyIdRef.current && terminalRef.current) {
        terminalRef.current.write(data)
        // Resolve terminal record ID (cached to avoid linear scan)
        if (!cachedTerminalId) {
          const terminalRecord = useTerminalStore.getState().findTerminalByPtyId(id)
          if (terminalRecord) {
            cachedTerminalId = terminalRecord.id
          }
        }
        if (cachedTerminalId) {
          noteTerminalActivity(cachedTerminalId)
        }
      }
    })

    cleanupExitListenerRef.current = terminalApi.onExit(
      (id: string, exitCode: number, signal?: number) => {
        if (id === ptyIdRef.current && onExitRef.current) {
          onExitRef.current(exitCode, signal)
        }
      }
    )

    // Spawn terminal if no external ID provided and auto-spawn enabled
    const initTerminal = async (): Promise<void> => {
      const spawnDebugId = `${instanceId}-spawn-${Date.now().toString().slice(-6)}`
      const recordReplayEvent = (
        name:
          | 'restore-replay-attempted'
          | 'restore-replay-succeeded'
          | 'restore-replay-failed'
          | 'restore-replay-skipped',
        details?: Record<string, unknown>,
        terminalEventId?: string,
        ptyId?: string
      ): void => {
        const projectId = continuityProjectIdRef.current
        recordTerminalContinuityEvent({
          name,
          correlationId: getOrCreateProjectContinuityCorrelation(projectId),
          projectId,
          terminalId: terminalEventId,
          ptyId,
          details
        })
      }

      devLog(`[ConnectedTerminal.initTerminal] START [${spawnDebugId}]`, {
        externalTerminalId,
        autoSpawn,
        spawnInFlight: spawnInFlightRef.current,
        hasPtyId: !!ptyIdRef.current
      })

      // Fit to get real dimensions BEFORE spawning
      performFit(true)
      const spawnCols = terminal.cols || 80
      const spawnRows = terminal.rows || 24

      if (!externalTerminalId) {
        if (!autoSpawn) {
          devLog(`[ConnectedTerminal.initTerminal] SKIP [${spawnDebugId}]: autoSpawn is false`)
          return
        }
        if (spawnInFlightRef.current || ptyIdRef.current) {
          devLog(
            `[ConnectedTerminal.initTerminal] SKIP [${spawnDebugId}]: already spawning or has PTY`
          )
          return
        }
      } else if (isTerminalPendingPtyAssignment(externalTerminalId)) {
        devLog(`SKIP autoSpawn: terminal ${externalTerminalId} pending PTY assignment from restore`)
        return
      }

      if (!externalTerminalId) {
        spawnInFlightRef.current = true
        devLog(`[ConnectedTerminal.initTerminal] SPAWNING [${spawnDebugId}]`, {
          cols: spawnCols,
          rows: spawnRows,
          spawnOpts: memoizedSpawnOptions
        })

        try {
          const spawnOpts = {
            ...memoizedSpawnOptions,
            // Ensure empty shell string is treated as undefined so Rust uses default
            shell: memoizedSpawnOptions?.shell || undefined,
            cols: spawnCols,
            rows: spawnRows
          }
          const result = await terminalApi.spawn(spawnOpts)
          devLog(`[ConnectedTerminal.initTerminal] SPAWN RESULT [${spawnDebugId}]`, {
            success: result.success,
            error: result.success ? undefined : result.error,
            ptyId: result.success ? result.data.id : 'FAILED'
          })

          if (result.success) {
            // Update ref immediately so listener can start processing data
            ptyIdRef.current = result.data.id
            useTerminalStore.getState().setRendererAttached(result.data.id, true)
            void addRendererRef(result.data.id, instanceIdRef.current)
            // If tab was visible before PTY was ready, flush deferred fit+resize now
            if (needsResizeOnReadyRef.current) {
              needsResizeOnReadyRef.current = false
              performFit(true)
              terminalApi.resize(result.data.id, terminal.cols, terminal.rows).catch(() => {})
            }
            // Register terminal for scrollback persistence
            registerTerminal(result.data.id, terminal)
            const terminalStoreState = useTerminalStore.getState()
            const transcript = terminalStoreState.peekTranscript(result.data.id)
            const transcriptLooksPartial =
              transcript.includes('\u001b[?1049h') || transcript.includes('\u001b[?47h')
            recordReplayEvent(
              'restore-replay-attempted',
              {
                mode: transcript ? 'transcript' : initialScrollback?.length ? 'scrollback' : 'none',
                transcriptLength: transcript.length,
                initialScrollbackLineCount: initialScrollback?.length ?? 0,
                source: 'spawned-terminal',
                alternateScreenDetected: transcriptLooksPartial
              },
              storeTerminalId,
              result.data.id
            )
            try {
              if (transcript) {
                if (transcriptLooksPartial) {
                  // R3: replay the full captured DEC mode set (alt-screen + bracketed-paste
                  // + cursor + mouse), not just alt-screen — a partial/trimmed transcript
                  // may miss the initial mode sequences. Idempotent with modes in the stream.
                  terminal.write(buildRehydrateSequences(initialModesRef.current))
                  terminal.write(transcript)
                  terminal.write(PARTIAL_RESTORE_NOTE)
                } else {
                  terminal.write(buildRehydrateSequences(initialModesRef.current))
                  terminal.write(transcript)
                }
                terminalStoreState.consumeTranscript(result.data.id)
                recordReplayEvent(
                  'restore-replay-succeeded',
                  {
                    mode: 'transcript',
                    transcriptLength: transcript.length,
                    source: 'spawned-terminal',
                    fullFidelity: !transcriptLooksPartial,
                    restoreLimitation: transcriptLooksPartial
                      ? 'alternate-screen-or-in-place-redraw'
                      : undefined
                  },
                  storeTerminalId,
                  result.data.id
                )
              } else if (initialScrollback && initialScrollback.length > 0) {
                restoreScrollback(terminal, initialScrollback, initialModes)
                recordReplayEvent(
                  'restore-replay-succeeded',
                  {
                    mode: 'scrollback',
                    initialScrollbackLineCount: initialScrollback.length,
                    // R3: whether DEC mode rehydrate sequences were emitted.
                    modesReplayed: Boolean(initialModes),
                    source: 'spawned-terminal'
                  },
                  storeTerminalId,
                  result.data.id
                )
              } else {
                recordReplayEvent(
                  'restore-replay-skipped',
                  {
                    reason: 'no-persisted-history',
                    source: 'spawned-terminal'
                  },
                  storeTerminalId,
                  result.data.id
                )
              }
            } catch (error) {
              const replayError = error instanceof Error ? error.message : String(error)
              recordReplayEvent(
                'restore-replay-failed',
                {
                  mode: transcript
                    ? 'transcript'
                    : initialScrollback?.length
                      ? 'scrollback'
                      : 'none',
                  error: replayError,
                  source: 'spawned-terminal'
                },
                storeTerminalId,
                result.data.id
              )
              console.error('[Terminal Replay Failed]', replayError)
              if (onErrorRef.current) onErrorRef.current(replayError)
            }
            // Write one-time info line if project env vars were applied
            if (memoizedSpawnOptions?.env && Object.keys(memoizedSpawnOptions.env).length > 0) {
              const envCount = Object.keys(memoizedSpawnOptions.env).length
              terminal.write(
                `\x1b[36m\r\n[Project env: ${envCount} variable${envCount !== 1 ? 's' : ''} applied]\x1b[0m\r\n`
              )
            }
            // Restore scroll position if cached from previous pane
            restoreScrollPosition(result.data.id, terminal)
            if (onSpawnedRef.current) {
              onSpawnedRef.current(result.data.id)
            }
            if (onBoundToStoreTerminalRef.current) {
              onBoundToStoreTerminalRef.current(result.data.id)
            }
            // CAP-3: capture the issued lease into the terminal store
            // (in-memory only). Runs after onBoundToStoreTerminal so the
            // store record's ptyId is set and the linear scan finds it.
            if (result.data.claim) {
              useTerminalStore.getState().setTerminalClaim(result.data.id, result.data.claim)
            }
          } else {
            const errorMsg = result.error || 'Unknown spawn error'
            console.error('[Terminal Spawn Failed]', errorMsg)
            terminal.write(
              `\x1b[31m\r\nFailed to spawn terminal process:\r\n${errorMsg}\x1b[0m\r\n`
            )
            if (onErrorRef.current) onErrorRef.current(errorMsg)
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Spawn failed'
          console.error('[Terminal Spawn Exception]', errorMsg)
          terminal.write(`\x1b[31m\r\nTerminal spawn exception:\r\n${errorMsg}\x1b[0m\r\n`)
          if (onErrorRef.current) onErrorRef.current(errorMsg)
        } finally {
          spawnInFlightRef.current = false
        }
      } else {
        // External terminal ID provided - register and restore scrollback
        devLog(`[ConnectedTerminal.initTerminal] EXTERNAL PTY [${spawnDebugId}]`, {
          externalTerminalId
        })
        // Set ptyIdRef so that resize/recovery operations (performFit, terminalApi.resize)
        // work for external terminals just like spawned ones. Without this, the TUI app
        // never receives SIGWINCH on project-switch restore and can't redraw.
        ptyIdRef.current = externalTerminalId
        // Renderer-attached tracking is handled by the externalTerminalId effect
        // above (with proper lifecycle cleanup). The effect also calls
        // setRendererAttached, so we avoid duplicating it here. The backend ref
        // (addRendererRef) is still registered here since it is async and not
        // managed by the effect's lifecycle.
        void addRendererRef(externalTerminalId, instanceIdRef.current)
        registerTerminal(externalTerminalId, terminal)
        const terminalStoreState = useTerminalStore.getState()
        const transcript = terminalStoreState.peekTranscript(externalTerminalId)
        const transcriptLooksPartial =
          transcript.includes('\u001b[?1049h') || transcript.includes('\u001b[?47h')
        recordReplayEvent(
          'restore-replay-attempted',
          {
            mode: transcript ? 'transcript' : initialScrollback?.length ? 'scrollback' : 'none',
            transcriptLength: transcript.length,
            initialScrollbackLineCount: initialScrollback?.length ?? 0,
            source: 'external-terminal',
            alternateScreenDetected: transcriptLooksPartial
          },
          storeTerminalId,
          externalTerminalId
        )
        try {
          if (cachedTerminal) {
            // Cached terminal already has full state — skip transcript/scrollback replay.
            // Still consume the transcript to prevent unbounded growth.
            if (transcript) {
              terminalStoreState.consumeTranscript(externalTerminalId)
            }
            recordReplayEvent(
              'restore-replay-skipped',
              {
                reason: 'cached-terminal',
                source: 'external-terminal'
              },
              storeTerminalId,
              externalTerminalId
            )
          } else if (transcript) {
            if (transcriptLooksPartial) {
              // R3: replay the full captured DEC mode set, not just alt-screen.
              terminal.write(buildRehydrateSequences(initialModesRef.current))
              terminal.write(transcript)
              terminal.write(PARTIAL_RESTORE_NOTE)
            } else {
              terminal.write(buildRehydrateSequences(initialModesRef.current))
              terminal.write(transcript)
            }
            terminalStoreState.consumeTranscript(externalTerminalId)
            recordReplayEvent(
              'restore-replay-succeeded',
              {
                mode: 'transcript',
                transcriptLength: transcript.length,
                source: 'external-terminal',
                fullFidelity: !transcriptLooksPartial,
                restoreLimitation: transcriptLooksPartial
                  ? 'alternate-screen-or-in-place-redraw'
                  : undefined
              },
              storeTerminalId,
              externalTerminalId
            )
          } else if (initialScrollback && initialScrollback.length > 0) {
            restoreScrollback(terminal, initialScrollback, initialModes)
            recordReplayEvent(
              'restore-replay-succeeded',
              {
                mode: 'scrollback',
                initialScrollbackLineCount: initialScrollback.length,
                // R3: whether DEC mode rehydrate sequences were emitted.
                modesReplayed: Boolean(initialModes),
                source: 'external-terminal'
              },
              storeTerminalId,
              externalTerminalId
            )
          } else {
            recordReplayEvent(
              'restore-replay-skipped',
              {
                reason: 'no-persisted-history',
                source: 'external-terminal'
              },
              storeTerminalId,
              externalTerminalId
            )
          }
        } catch (error) {
          const replayError = error instanceof Error ? error.message : String(error)
          recordReplayEvent(
            'restore-replay-failed',
            {
              mode: transcript ? 'transcript' : initialScrollback?.length ? 'scrollback' : 'none',
              error: replayError,
              source: 'external-terminal'
            },
            storeTerminalId,
            externalTerminalId
          )
          console.error('[Terminal Replay Failed]', replayError)
          if (onErrorRef.current) onErrorRef.current(replayError)
        }
        // Write one-time info line if project env vars were applied
        // (env should be passed via spawnOptions by the caller if this terminal was spawned with env vars)
        if (memoizedSpawnOptions?.env && Object.keys(memoizedSpawnOptions.env).length > 0) {
          const envCount = Object.keys(memoizedSpawnOptions.env).length
          terminal.write(
            `\x1b[36m\r\n[Project env: ${envCount} variable${envCount !== 1 ? 's' : ''} applied]\x1b[0m\r\n`
          )
        }
        // Restore scroll position if cached from previous pane
        restoreScrollPosition(externalTerminalId, terminal)
        if (onBoundToStoreTerminalRef.current) {
          onBoundToStoreTerminalRef.current(externalTerminalId)
        }
      }
    }

    devLog(`[ConnectedTerminal] Calling initTerminal [${debugId}]`)
    initTerminal()

    return () => {
      devLog(`[ConnectedTerminal] UNMOUNT [${debugId}]`, {
        instanceId,
        ptyId: ptyIdRef.current,
        externalTerminalId
      })
      // Capture scroll position BEFORE unregistering for pane transitions
      const terminalId = ptyIdRef.current || externalTerminalId
      if (terminalId && terminalRef.current) {
        captureScrollPosition(terminalId)
        useTerminalStore.getState().setRendererAttached(terminalId, false)
        void removeRendererRef(terminalId, instanceId)
      }

      // Unregister terminal from registry
      if (ptyIdRef.current) {
        unregisterTerminal(ptyIdRef.current)
      } else if (externalTerminalId) {
        unregisterTerminal(externalTerminalId)
      }

      // PTY lifecycle is handled by explicit terminal close, not component unmount
      dataDisposable.dispose()
      if (cleanupDataListenerRef.current) {
        cleanupDataListenerRef.current()
        cleanupDataListenerRef.current = null
      }
      if (cleanupExitListenerRef.current) {
        cleanupExitListenerRef.current()
        cleanupExitListenerRef.current = null
      }

      clearTerminalActivityOnUnmount()
      // Cursor cleanup: Disable cursor blink before WebGL disposal to prevent ghost cursors
      if (terminalRef.current) {
        terminalRef.current.options.cursorBlink = false
      }

      // Dispose WebGL addon BEFORE terminal disposal for proper cursor layer cleanup
      disposeWebglAddon()
      if (fileLinkProviderDisposableRef.current) {
        fileLinkProviderDisposableRef.current.dispose()
        fileLinkProviderDisposableRef.current = null
      }

      // Cache the terminal for reuse on project-switch-back instead of
      // disposing it. This preserves all xterm internal state (scrollback,
      // alt buffer, cursor position). Only cache if the terminal is still
      // alive in the store (not closed/exited) — otherwise dispose.
      const cacheKey = terminalId
      const terminalStillInStore =
        cacheKey && useTerminalStore.getState().findTerminalByPtyId(cacheKey)
      if (terminalStillInStore) {
        cacheTerminal(cacheKey, terminal)
      } else {
        terminal.dispose()
      }
      terminalRef.current = null
      setTerminalInstance(null)
      fitAddonRef.current = null
      searchAddonRef.current = null
      ptyIdRef.current = null
      spawnInFlightRef.current = false
      // Reset init flag so a new terminal can be created if component remounts
      didInitRef.current = false
      initializedTerminalIdRef.current = undefined
      // Reset WebGL recovery state for next terminal creation
      webglRecoveryAttemptsRef.current = 0
      webglContextLostRef.current = false
      loadWebglAddonRef.current = null
    }
  }, [])

  // Update terminal font settings when app settings change (without recreating terminal)
  // biome-ignore lint/correctness/useExhaustiveDependencies: performFit is render-stable by design
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontFamily = fontFamily
      terminalRef.current.options.fontSize = fontSize
      performFit(true)
    }
  }, [fontFamily, fontSize])

  // WebGL recovery state machine: attempt counters, context-loss/DPR
  // bookkeeping, dispose path, and the renderer-preference/DPR recovery
  // triggers live in useWebglRecovery; the loadWebglAddon closures in the
  // init effects write back through loadWebglAddonRef.
  const {
    disposeWebglAddon,
    loadWebglAddonRef,
    webglRecoveryAttemptsRef,
    webglRecoveryTimeoutRef,
    webglContextLostRef,
    webglDprWatchedRef
  } = useWebglRecovery({
    terminalRef,
    webglAddonRef,
    rendererPreferenceRef,
    isMobileWebShellRef,
    effectiveRendererPreference,
    rendererPreference,
    isMobileWebShell
  })

  // Fit/resize/visibility recovery chains (performFit, the sidebar
  // activity debounce, the deferred fit-on-spawn flag, and the
  // visibilitychange/focus/power-resume triggers) live in useTerminalFit.
  const {
    performFit,
    needsResizeOnReadyRef,
    noteTerminalActivity,
    clearTerminalActivityOnUnmount
  } = useTerminalFit({
    terminalRef,
    fitAddonRef,
    containerRef,
    ptyIdRef,
    isVisibleRef,
    isVisible,
    targetId,
    webglRecoveryTimeoutRef,
    forceResizeFit
  })

  const handleContainerClick = useCallback((): void => {
    terminalRef.current?.focus()
  }, [])

  const handleSelectAll = useCallback((): void => {
    terminalRef.current?.selectAll()
  }, [])

  useImperativeHandle(searchRef, () => {
    return {
      findNext: (term: string) =>
        searchAddonRef.current?.findNext(term, {
          decorations: getTerminalSearchDecorations()
        }) ?? false,
      findPrevious: (term: string) =>
        searchAddonRef.current?.findPrevious(term, {
          decorations: getTerminalSearchDecorations()
        }) ?? false,
      clearDecorations: () => searchAddonRef.current?.clearDecorations(),
      writeText: (text: string) => {
        if (ptyIdRef.current) terminalApi.write(ptyIdRef.current, text)
      }
    }
  }, [])

  const shouldDebugLog = import.meta.env.DEV
  const devLog = (...args: unknown[]): void => {
    if (shouldDebugLog) console.log(...args)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally narrow deps; a full list would recreate the terminal instance on every render
  useEffect(() => {
    if (!containerRef.current || !targetId) return
    if (didInitRef.current) return
    didInitRef.current = true
    initializedTerminalIdRef.current = targetId
    const terminalOptions = {
      ...getTerminalOptions(navigator.platform),
      fontFamily,
      fontSize,
      scrollback: bufferSize
    }
    const terminal = new Terminal(terminalOptions)
    terminalRef.current = terminal
    setTerminalInstance(terminal)
    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(new WebLinksAddon())
    const searchAddon = new SearchAddon()
    searchAddonRef.current = searchAddon
    terminal.loadAddon(searchAddon)
    terminal.open(containerRef.current)
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') return true

      const shortcuts = shortcutsRef.current

      if (isAppOwnedTerminalShortcut(event, shortcuts)) {
        if (isMac && event.ctrlKey && !event.metaKey) {
          return true
        }
        return false
      }

      const clipboardResult = handleTerminalClipboardKey(event, terminal, lastClipboardOpRef, {
        copySelection: () => void copySelectionRef.current(),
        pasteFromClipboard: () => void pasteFromClipboardRef.current()
      })
      if (clipboardResult !== undefined) return clipboardResult
      if (trapTerminalTabFocusNavigation(event)) {
        return true
      }
      return true
    })
    const loadWebglAddon = (term: Terminal, _isRecovery: boolean = false): void => {
      if (
        !shouldUseWebglRenderer(rendererPreferenceRef.current, isMobileWebShellRef.current) ||
        webglAddonRef.current ||
        webglRecoveryAttemptsRef.current >= MAX_WEBGL_RECOVERY_ATTEMPTS
      )
        return
      try {
        const webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => {
          webglAddon.dispose()
          webglAddonRef.current = null
          webglDprWatchedRef.current = 0
          webglContextLostRef.current = true
          webglRecoveryAttemptsRef.current++
          if (webglRecoveryTimeoutRef.current) {
            clearTimeout(webglRecoveryTimeoutRef.current)
          }
          webglRecoveryTimeoutRef.current = setTimeout(() => {
            webglRecoveryTimeoutRef.current = null
            loadWebglAddon(term, true)
          }, WEBGL_CONTEXT_LOSS_RECOVERY_DELAY_MS)
        })
        term.loadAddon(webglAddon)
        webglAddonRef.current = webglAddon
        webglContextLostRef.current = false
        // Story 3 (P0, blank canvas at DPR >= 3): the addon activated before
        // the terminal's char-size service had valid measurements, so its
        // constructor-captured dimensions can be stale/zero while the canvas
        // backing store (devicePixelContentBoxSize observer) is already
        // sized. Force the same re-sync the xterm core performs for DPR
        // changes — renderService.handleDevicePixelRatioChange re-reads dpr
        // and rebuilds renderer dimensions + texture atlas — then full
        // refresh + forced fit so the cell grid and canvas re-converge at the
        // CURRENT devicePixelRatio. Guarded: a throw degrades to the failure
        // log below (log-api), never a crash.
        try {
          resyncWebglDimensions(term)
          webglDprWatchedRef.current = getDevicePixelRatio()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          void logFrontendError({
            level: 'error',
            source: 'ConnectedTerminal.loadWebglAddon',
            message: `WebGL dimensions re-sync failed after addon load: ${message} (${describeWebglContext(term)})`,
            stack: error instanceof Error ? error.stack : undefined
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        webglRecoveryAttemptsRef.current++
        console.warn('WebGL addon failed to load, falling back to DOM renderer:', error)
        // Story 3: durable failure log (log-api) — dpr, css size, addon
        // package. Metadata only, never secrets.
        void logFrontendError({
          level: 'error',
          source: 'ConnectedTerminal.loadWebglAddon',
          message: `WebGL addon failed to load, falling back to DOM renderer: ${message} (${describeWebglContext(term)})`,
          stack: error instanceof Error ? error.stack : undefined
        })
      }
    }
    if (shouldUseWebglRenderer(rendererPreferenceRef.current, isMobileWebShellRef.current))
      loadWebglAddon(terminal)
    loadWebglAddonRef.current = loadWebglAddon
    requestAnimationFrame(() => performFit(true))
    if (autoFocus) terminal.focus()
    const resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => performFit()))
    resizeObserver.observe(containerRef.current)
    const dataDisposable = terminal.onData(handleTerminalData)
    const resizeDisposable = terminal.onResize(({ cols, rows }) => handlePtyResize(cols, rows))
    cleanupDataListenerRef.current = terminalApi.onData((id: string, data: Uint8Array) => {
      if (id === ptyIdRef.current && terminalRef.current) {
        terminalRef.current.write(data)
        const terminalRecord = useTerminalStore.getState().findTerminalByPtyId(id)
        if (terminalRecord) {
          noteTerminalActivity(terminalRecord.id)
        }
      }
    })
    cleanupExitListenerRef.current = terminalApi.onExit(
      (pId: string, exitCode: number, signal?: number) => {
        if (pId === ptyIdRef.current) {
          if (targetId)
            useTerminalStore.getState().setTerminalHealthStatus(targetId, 'disconnected')
          if (onExitRef.current) onExitRef.current(exitCode, signal)
        }
      }
    )
    const spawnTerminal = async (): Promise<void> => {
      performFit(true)
      if (!externalTerminalId) {
        if (!autoSpawn || spawnInFlightRef.current || ptyIdRef.current) return
        spawnInFlightRef.current = true
        try {
          const currentSpawnOptions = spawnOptionsRef.current
          const result = await terminalApi.spawn({
            ...currentSpawnOptions,
            shell: currentSpawnOptions?.shell || undefined,
            cols: terminal.cols || 80,
            rows: terminal.rows || 24
          })
          if (result.success) {
            ptyIdRef.current = result.data.id
            useTerminalStore.getState().setRendererAttached(result.data.id, true)
            void addRendererRef(result.data.id, instanceIdRef.current)
            registerTerminal(result.data.id, terminal)
            const transcript = useTerminalStore.getState().peekTranscript(result.data.id)
            if (transcript) {
              // R3: replay captured modes before the (possibly trimmed) transcript.
              terminal.write(buildRehydrateSequences(initialModesRef.current))
              terminal.write(transcript)
              useTerminalStore.getState().consumeTranscript(result.data.id)
            } else if (initialScrollbackRef.current?.length)
              restoreScrollback(terminal, initialScrollbackRef.current, initialModesRef.current)
            if (onSpawnedRef.current) onSpawnedRef.current(result.data.id)
            if (onBoundToStoreTerminalRef.current) onBoundToStoreTerminalRef.current(result.data.id)
            // CAP-3: capture the issued lease (in-memory only), after the
            // store record's ptyId binding so the scan finds it.
            if (result.data.claim) {
              useTerminalStore.getState().setTerminalClaim(result.data.id, result.data.claim)
            }
          } else if (onErrorRef.current) onErrorRef.current(result.error)
        } catch (err) {
          if (onErrorRef.current)
            onErrorRef.current(err instanceof Error ? err.message : 'Spawn failed')
        } finally {
          spawnInFlightRef.current = false
        }
      } else {
        void addRendererRef(externalTerminalId, instanceIdRef.current)
        registerTerminal(externalTerminalId, terminal)
        const transcript = useTerminalStore.getState().peekTranscript(externalTerminalId)
        if (transcript) {
          // R3: replay captured modes before the (possibly trimmed) transcript.
          terminal.write(buildRehydrateSequences(initialModesRef.current))
          terminal.write(transcript)
          useTerminalStore.getState().consumeTranscript(externalTerminalId)
        } else if (initialScrollbackRef.current?.length)
          restoreScrollback(terminal, initialScrollbackRef.current, initialModesRef.current)
        if (onBoundToStoreTerminalRef.current) onBoundToStoreTerminalRef.current(externalTerminalId)
      }
    }
    spawnTerminal()
    return () => {
      const tId = ptyIdRef.current || externalTerminalId
      if (tId && terminalRef.current) {
        captureScrollPosition(tId)
        if (!externalTerminalId) useTerminalStore.getState().setRendererAttached(tId, false)
        void removeRendererRef(tId, instanceId)
      }
      if (ptyIdRef.current) unregisterTerminal(ptyIdRef.current)
      else if (externalTerminalId) unregisterTerminal(externalTerminalId)
      resizeObserver.disconnect()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      if (cleanupDataListenerRef.current) cleanupDataListenerRef.current()
      if (cleanupExitListenerRef.current) cleanupExitListenerRef.current()

      clearTerminalActivityOnUnmount()
      disposeWebglAddon()
      terminal.dispose()
      terminalRef.current = null
      setTerminalInstance(null)
      didInitRef.current = false
      initializedTerminalIdRef.current = undefined
    }
  }, [
    targetId,
    autoSpawn,
    rendererPreference,
    fontFamily,
    fontSize,
    bufferSize,
    instanceId,
    externalTerminalId,
    autoFocus,
    handleTerminalData,
    handlePtyResize,
    disposeWebglAddon,
    clearTerminalActivityOnUnmount
  ])

  const isCrashed = healthStatus === 'disconnected' || healthStatus === 'crashed'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="relative w-full h-full group overflow-hidden">
          <div
            className={`w-full h-full bg-terminal-bg py-0.5 pb-1 ${
              isMobileWebShell ? 'px-1.5' : 'px-4'
            } ${className}`}
            onClick={handleContainerClick}
            onMouseDown={(e) => {
              // Prevent event from bubbling to window/parent handlers
              // that might steal focus back or interfere with UI
              e.stopPropagation()
              if (terminalRef.current) {
                terminalRef.current.focus()
              }
            }}
          >
            <div ref={containerRef} className="w-full h-full" />
          </div>
          {isCrashed && (
            <div className="absolute inset-0 bg-background/40 backdrop-blur-md flex items-center justify-center z-50 p-4 md:p-8 animate-in fade-in zoom-in-95 duration-300 text-foreground">
              <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-6 bg-card/95 border border-border/50 p-8 rounded-2xl shadow-2xl max-w-2xl w-full border-t-4 border-t-destructive">
                <div className="flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-border/50 pb-6 md:pb-0 md:pr-6">
                  <div className="w-20 h-20 rounded-2xl bg-destructive/10 flex items-center justify-center mb-3 shadow-inner group-hover:scale-110 transition-transform duration-500">
                    <AlertTriangle className="text-destructive" size={40} />
                  </div>
                  <span className="text-3xs uppercase tracking-[0.2em] font-black text-destructive/80 text-center">
                    CRITICAL ERROR
                  </span>
                </div>
                <div className="flex flex-col justify-center text-center md:text-left">
                  <div className="mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wider opacity-70">
                    Terminal Pane Exception
                  </div>
                  <h3 className="text-2xl md:text-3xl font-bold tracking-tighter mb-3">
                    Session Interrupted
                  </h3>
                  <p className="text-muted-foreground leading-relaxed text-sm md:text-base mb-8">
                    The terminal process exited unexpectedly. This usually happens if the shell
                    crashes or the PTY is killed by the OS.
                  </p>
                  <div className="flex flex-col sm:flex-row items-center gap-4">
                    <Button
                      type="button"
                      size="lg"
                      className="w-full rounded-xl px-8 font-semibold sm:w-auto [&_svg]:size-5"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (targetId) restartTerminal(targetId)
                      }}
                    >
                      <RefreshCcw /> Reconnect Session
                    </Button>
                    <div className="hidden sm:block h-8 w-px bg-border/50 mx-2" />
                    <div className="text-3xs text-muted-foreground/60 font-mono">
                      REF::{targetId?.slice(0, 8)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
          {assistPanel ? (
            <TerminalAssistPanel
              state={assistPanel}
              onClose={() => setAssistPanel(null)}
              onInsertCommand={(command) => void insertAssistCommand(command)}
            />
          ) : null}
          {/* Story 10 (F9/F10): non-blocking terminal-channel outage overlay.
              While `/terminal/ws` is reconnecting, keystrokes are buffered
              (bounded, replayed after re-attach) — the overlay makes that
              visible so buffering is never silent. The "input buffered"
              promise is made only when THIS terminal is actually bufferable
              (live, claim-held — `isWebTerminalBufferable`); a terminal that
              cannot buffer gets the plain state label and its write failures
              toast instead. Mirrors the AgentChatPanel reconnect overlay
              (pointer-events-none + AgentConnectionLamp). Suppressed while
              the crash overlay is up, and explicitly gated off on Tauri (desktop
              terminal I/O is direct IPC — no WS channel to outage). */}
          {!isCrashed && !isTauriContext() && terminalChannel !== 'connected' && (
            <div
              className="pointer-events-none absolute right-2 top-2 z-20 flex items-center gap-1.5 rounded-full border border-border/60 bg-background/80 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm"
              role="status"
              aria-live="polite"
            >
              <AgentConnectionLamp
                connected={false}
                reconnecting={terminalChannel !== 'disconnected'}
                decorative
                size={8}
              />
              <span>
                {terminalChannel === 'disconnected'
                  ? 'Disconnected'
                  : terminalChannel === 'reconnecting'
                    ? ptyIdRef.current && isWebTerminalBufferable(ptyIdRef.current)
                      ? 'Reconnecting — input buffered'
                      : 'Reconnecting…'
                    : 'Connecting…'}
              </span>
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem
          onSelect={copySelection}
          disabled={!hasSelection}
          className="cursor-pointer"
        >
          Copy <ContextMenuShortcut>{SHORTCUT_MOD}+C</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={pasteFromClipboard} className="cursor-pointer">
          Paste <ContextMenuShortcut>{SHORTCUT_MOD}+V</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={handleSelectAll} className="cursor-pointer">
          Select All <ContextMenuShortcut>{SHORTCUT_MOD}+A</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => void runTerminalAssist('explain')}
          disabled={!hasSelection}
          className="cursor-pointer"
        >
          Explain with AI
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => void runTerminalAssist('fix')}
          disabled={!hasSelection}
          className="cursor-pointer"
        >
          Fix Command with AI
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => {
            if (targetId) restartTerminal(targetId)
          }}
          className="cursor-pointer text-primary focus:text-primary"
        >
          <RefreshCcw size={14} className="mr-2" /> Restart Terminal
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export const ConnectedTerminal = memo(ConnectedTerminalComponent)
