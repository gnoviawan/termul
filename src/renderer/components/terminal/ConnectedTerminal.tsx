import { useEffect, useRef, memo, useCallback, useMemo, useImperativeHandle, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import type { TerminalSpawnOptions } from '../../../shared/types/ipc.types'
import { getTerminalOptions, RESIZE_DEBOUNCE_MS } from './terminal-config'
import {
  registerTerminal,
  unregisterTerminal,
  restoreScrollback
} from '../../utils/terminal-registry'
import { useTerminalFontFamily, useTerminalFontSize, useTerminalBufferSize } from '@/stores/app-settings-store'
import {
  useKeyboardShortcutsStore,
  normalizeKeyEvent
} from '@/stores/keyboard-shortcuts-store'
import { useTerminalStore } from '@/stores/terminal-store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useTerminalClipboard } from '@/hooks/use-terminal-clipboard'

export interface TerminalSearchHandle {
  findNext: (term: string) => boolean
  findPrevious: (term: string) => boolean
  clearDecorations: () => void
  writeText: (text: string) => void
}

export interface ConnectedTerminalProps {
  terminalId?: string
  spawnOptions?: TerminalSpawnOptions
  onSpawned?: (terminalId: string) => void
  onExit?: (exitCode: number, signal?: number) => void
  onError?: (error: string) => void
  onCommand?: (command: string) => void
  className?: string
  autoFocus?: boolean
  initialScrollback?: string[] // Scrollback to restore on mount
  searchRef?: React.Ref<TerminalSearchHandle>
  isVisible?: boolean // Whether this terminal is currently visible (for fit triggering)
}

function ConnectedTerminalComponent({
  terminalId: externalTerminalId,
  spawnOptions,
  onSpawned,
  onExit,
  onError,
  onCommand,
  className = '',
  autoFocus = true,
  initialScrollback,
  searchRef,
  isVisible = true
}: ConnectedTerminalProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)

  // Get font settings from app settings store
  const fontFamily = useTerminalFontFamily()
  const fontSize = useTerminalFontSize()
  const bufferSize = useTerminalBufferSize()

  // Get keyboard shortcuts to intercept app shortcuts before xterm handles them
  const shortcuts = useKeyboardShortcutsStore((state) => state.shortcuts)
  // Use ref to avoid stale closure in attachCustomKeyEventHandler
  const shortcutsRef = useRef(shortcuts)
  shortcutsRef.current = shortcuts
  const cleanupDataListenerRef = useRef<(() => void) | null>(null)
  const cleanupExitListenerRef = useRef<(() => void) | null>(null)
  // Use ref to track current PTY ID for listener callbacks to avoid stale closures
  const ptyIdRef = useRef<string | null>(null)
  // Use refs for callbacks to avoid dependency changes
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const onCommandRef = useRef(onCommand)
  onCommandRef.current = onCommand
  // Track current input line for command history
  const currentLineRef = useRef<string>('')
  // Resize debounce timer ref
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Activity timeout timer ref
  const activityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Rate limiting for clipboard operations
  const lastClipboardOpRef = useRef<number>(0)
  const CLIPBOARD_RATE_LIMIT_MS = 100 // Minimum ms between clipboard operations

  // State to track terminal instance for clipboard hook
  const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(null)

  // Clipboard functionality
  const { copySelection, pasteFromClipboard, hasSelection } = useTerminalClipboard({
    terminal: terminalInstance
  })

  // Sync ptyIdRef with external terminal ID when provided
  useEffect(() => {
    if (externalTerminalId) {
      ptyIdRef.current = externalTerminalId
    }
  }, [externalTerminalId])

  // Memoize spawn options to prevent unnecessary re-spawns
  const memoizedSpawnOptions = useMemo(
    () => spawnOptions,
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        const result = await window.api.terminal.write(ptyId, data)
        if (!result.success && onError) {
          onError(result.error)
        }
      } catch (err) {
        if (onError) {
          onError(err instanceof Error ? err.message : 'Write failed')
        }
      }
    },
    [onError]
  )

  // Handle resize events with debouncing to prevent IPC flooding
  const handleResize = useCallback(async (cols: number, rows: number): Promise<void> => {
    const ptyId = ptyIdRef.current
    if (!ptyId) return

    // Clear existing timeout
    if (resizeTimeoutRef.current) {
      clearTimeout(resizeTimeoutRef.current)
    }

    // Debounce resize IPC calls - re-read ptyId inside timeout to avoid stale closure
    resizeTimeoutRef.current = setTimeout(async () => {
      const currentPtyId = ptyIdRef.current
      if (!currentPtyId) return

      try {
        await window.api.terminal.resize(currentPtyId, cols, rows)
      } catch {
        // Ignore resize errors during rapid resize
      }
    }, RESIZE_DEBOUNCE_MS)
  }, [])

  // Expose search methods via ref
  useImperativeHandle(
    searchRef,
    () => ({
      findNext: (term: string) => {
        if (!searchAddonRef.current) return false
        return searchAddonRef.current.findNext(term, {
          decorations: {
            matchBackground: '#444444',
            matchBorder: '#888888',
            matchOverviewRuler: '#888888',
            activeMatchBackground: '#FFFF00',
            activeMatchBorder: '#FFFF00',
            activeMatchColorOverviewRuler: '#FFFF00'
          }
        })
      },
      findPrevious: (term: string) => {
        if (!searchAddonRef.current) return false
        return searchAddonRef.current.findPrevious(term, {
          decorations: {
            matchBackground: '#444444',
            matchBorder: '#888888',
            matchOverviewRuler: '#888888',
            activeMatchBackground: '#FFFF00',
            activeMatchBorder: '#FFFF00',
            activeMatchColorOverviewRuler: '#FFFF00'
          }
        })
      },
      clearDecorations: () => {
        if (searchAddonRef.current) {
          searchAddonRef.current.clearDecorations()
        }
      },
      writeText: (text: string) => {
        const ptyId = ptyIdRef.current
        if (!ptyId) return
        window.api.terminal.write(ptyId, text)
      }
    }),
    []
  )

  // Initialize terminal, set up IPC listeners, and spawn PTY
  useEffect(() => {
    if (!containerRef.current) return

    // Merge platform-aware options with dynamic app settings
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

    const webLinksAddon = new WebLinksAddon()
    terminal.loadAddon(webLinksAddon)

    // Load search addon
    const searchAddon = new SearchAddon()
    searchAddonRef.current = searchAddon
    terminal.loadAddon(searchAddon)

    terminal.open(containerRef.current)

    // Intercept keyboard shortcuts before xterm processes them
    // Return false to prevent xterm from handling, true to let xterm handle
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== 'keydown') return true

      const normalized = normalizeKeyEvent(event)
      const shortcuts = shortcutsRef.current

      // Check if this key matches any app shortcut
      for (const shortcut of Object.values(shortcuts)) {
        const activeKey = shortcut.customKey ?? shortcut.defaultKey
        if (normalized === activeKey) {
          // Don't call stopPropagation() - let event bubble to window handler
          // Return false to prevent xterm from handling the event
          return false
        }
      }

      // Handle copy/paste/select all keyboard shortcuts
      const isCtrlOrCmd = event.ctrlKey || event.metaKey

      if (isCtrlOrCmd) {
        // Rate limit check
        const now = Date.now()
        if (now - lastClipboardOpRef.current < CLIPBOARD_RATE_LIMIT_MS) {
          return false // Rate limited - prevent xterm handling but don't process
        }

        switch (event.key.toLowerCase()) {
          case 'c':
            // Copy: if selection exists, copy and prevent xterm handling
            // Otherwise allow xterm to handle (for interrupt signal)
            if (terminal.hasSelection()) {
              const selection = terminal.getSelection()
              if (selection) {
                lastClipboardOpRef.current = now
                // Use the hook's copySelection for consistency
                void copySelection()
              }
              return false
            }
            // No selection - allow xterm to send Ctrl+C (interrupt signal)
            return true

          case 'v':
            // Paste: read clipboard and paste to terminal
            lastClipboardOpRef.current = now
            // Use the hook's pasteFromClipboard for consistency
            void pasteFromClipboard()
            return false

          case 'a':
            // Select all
            terminal.selectAll()
            return false
        }
      }

      return true
    })

    try {
      const webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        webglAddon.dispose()
      })
      terminal.loadAddon(webglAddon)
    } catch {
      console.warn('WebGL addon failed to load, falling back to canvas renderer')
    }

    fitAddon.fit()

    if (autoFocus) {
      terminal.focus()
    }

    // Set up resize observer
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (fitAddonRef.current && terminalRef.current) {
          try {
            fitAddonRef.current.fit()
          } catch {
            // Ignore fit errors during rapid resize
          }
        }
      })
    })
    resizeObserver.observe(containerRef.current)

    // Listen for input from xterm
    const dataDisposable = terminal.onData(handleTerminalData)
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      handleResize(cols, rows)
    })

    // Set up IPC listeners BEFORE spawning to avoid missing data
    cleanupDataListenerRef.current = window.api.terminal.onData((id: string, data: string) => {
      if (id === ptyIdRef.current && terminalRef.current) {
        terminalRef.current.write(data)
        // Update activity state in store
        const terminal = useTerminalStore.getState().findTerminalByPtyId(id)
        if (terminal) {
          useTerminalStore.getState().updateTerminalActivity(terminal.id, true)
          useTerminalStore.getState().updateTerminalLastActivityTimestamp(terminal.id, Date.now())

          // Clear existing activity timeout and set new one
          if (activityTimeoutRef.current) {
            clearTimeout(activityTimeoutRef.current)
          }
          activityTimeoutRef.current = setTimeout(() => {
            // Clear activity after 2 seconds of inactivity
            useTerminalStore.getState().updateTerminalActivity(terminal.id, false)
            activityTimeoutRef.current = null
          }, 2000)
        }
      }
    })

    cleanupExitListenerRef.current = window.api.terminal.onExit(
      (id: string, exitCode: number, signal?: number) => {
        if (id === ptyIdRef.current && onExitRef.current) {
          onExitRef.current(exitCode, signal)
        }
      }
    )

    // Spawn terminal if no external ID provided
    const initTerminal = async (): Promise<void> => {
      // Fit to get real dimensions BEFORE spawning
      try {
        fitAddon.fit()
      } catch {
        // Ignore fit errors if container not properly laid out yet
      }
      const spawnCols = terminal.cols
      const spawnRows = terminal.rows

      if (!externalTerminalId) {
        try {
          const result = await window.api.terminal.spawn({
            ...memoizedSpawnOptions,
            cols: spawnCols,
            rows: spawnRows
          })
          if (result.success) {
            // Update ref immediately so listener can start processing data
            ptyIdRef.current = result.data.id
            // Register terminal for scrollback persistence
            registerTerminal(result.data.id, terminal)
            // Restore scrollback if provided
            if (initialScrollback && initialScrollback.length > 0) {
              restoreScrollback(terminal, initialScrollback)
            }
            if (onSpawned) {
              onSpawned(result.data.id)
            }
          } else if (onError) {
            onError(result.error)
          }
        } catch (err) {
          if (onError) {
            onError(err instanceof Error ? err.message : 'Spawn failed')
          }
        }
      } else {
        // External terminal ID provided - register and restore scrollback
        registerTerminal(externalTerminalId, terminal)
        if (initialScrollback && initialScrollback.length > 0) {
          restoreScrollback(terminal, initialScrollback)
        }
      }
    }

    initTerminal()

    return () => {
      // Unregister terminal from registry
      if (ptyIdRef.current) {
        unregisterTerminal(ptyIdRef.current)
      } else if (externalTerminalId) {
        unregisterTerminal(externalTerminalId)
      }
      // Kill PTY process on unmount to prevent orphaned shell processes
      if (ptyIdRef.current) {
        const killPromise = window.api.terminal.kill(ptyIdRef.current)
        if (killPromise && typeof killPromise.catch === 'function') {
          killPromise.catch(() => {
            // Ignore kill errors during cleanup
          })
        }
      }
      resizeObserver.disconnect()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      if (cleanupDataListenerRef.current) {
        cleanupDataListenerRef.current()
        cleanupDataListenerRef.current = null
      }
      if (cleanupExitListenerRef.current) {
        cleanupExitListenerRef.current()
        cleanupExitListenerRef.current = null
      }
      // Clean up resize debounce timer
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current)
      }
      // Clean up activity timeout timer
      if (activityTimeoutRef.current) {
        clearTimeout(activityTimeoutRef.current)
      }
      terminal.dispose()
      terminalRef.current = null
      setTerminalInstance(null)
      fitAddonRef.current = null
      searchAddonRef.current = null
      ptyIdRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fontFamily and fontSize handled by separate effect
  }, [
    externalTerminalId,
    memoizedSpawnOptions,
    onSpawned,
    onError,
    autoFocus,
    handleTerminalData,
    handleResize,
    initialScrollback,
    bufferSize
  ])

  // Update terminal font settings when app settings change (without recreating terminal)
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontFamily = fontFamily
      terminalRef.current.options.fontSize = fontSize
      // Re-fit terminal after font change
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.fit()
        } catch {
          // Ignore fit errors
        }
      }
    }
  }, [fontFamily, fontSize])

  // Trigger fit when terminal becomes visible
  useEffect(() => {
    if (isVisible && fitAddonRef.current && terminalRef.current) {
      // Use requestAnimationFrame to ensure container dimensions are updated
      requestAnimationFrame(() => {
        try {
          fitAddonRef.current?.fit()
        } catch {
          // Ignore fit errors
        }
      })
    }
  }, [isVisible])

  // Handle Select All
  const handleSelectAll = useCallback((): void => {
    if (terminalRef.current) {
      terminalRef.current.selectAll()
    }
  }, [])

  // Memoized context menu handlers to prevent unnecessary re-renders
  const contextMenuHandlers = useMemo(() => ({
    copy: copySelection,
    paste: pasteFromClipboard,
    selectAll: handleSelectAll
  }), [copySelection, pasteFromClipboard, handleSelectAll])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          className={`w-full h-full ${className}`}
          style={{ padding: '8px' }}
        />
      </ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuItem
          onClick={contextMenuHandlers.copy}
          disabled={!hasSelection}
          className="cursor-pointer"
          aria-label="Copy selected text"
          aria-keyshortcuts="Ctrl+C"
        >
          Copy
          <span className="ml-auto text-xs text-muted-foreground">Ctrl+C</span>
        </ContextMenuItem>
        <ContextMenuItem
          onClick={contextMenuHandlers.paste}
          className="cursor-pointer"
          aria-label="Paste from clipboard"
          aria-keyshortcuts="Ctrl+V"
        >
          Paste
          <span className="ml-auto text-xs text-muted-foreground">Ctrl+V</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={contextMenuHandlers.selectAll}
          className="cursor-pointer"
          aria-label="Select all text"
          aria-keyshortcuts="Ctrl+A"
        >
          Select All
          <span className="ml-auto text-xs text-muted-foreground">Ctrl+A</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export const ConnectedTerminal = memo(ConnectedTerminalComponent)
