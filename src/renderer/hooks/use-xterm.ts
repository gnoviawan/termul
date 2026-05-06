import { useRef, useCallback, useEffect } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { TERMINAL_THEME } from '../components/terminal/terminal-config'
import { createTerminalSession, loadWebglAddon } from '../components/terminal/terminal-factory'

export interface UseXtermOptions {
  onData?: (data: string) => void
  onResize?: (cols: number, rows: number) => void
  fontSize?: number
  fontFamily?: string
  scrollback?: number
  renderer?: 'webgl' | 'dom'
}

export interface UseXtermReturn {
  terminalRef: React.RefObject<Terminal | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  isReady: boolean
  write: (data: string) => void
  writeln: (data: string) => void
  clear: () => void
  focus: () => void
  blur: () => void
  fit: () => void
  scrollToBottom: () => void
  getCols: () => number
  getRows: () => number
}

export function useXterm(options: UseXtermOptions = {}): UseXtermReturn {
  const {
    onData,
    onResize,
    fontSize = 14,
    fontFamily = 'Menlo, Monaco, "Courier New", monospace',
    scrollback = 10000,
    renderer = 'webgl'
  } = options

  const terminalRef = useRef<Terminal | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const webglAddonRef = useRef<ReturnType<typeof loadWebglAddon> | null>(null)
  const isReadyRef = useRef(false)

  const write = useCallback((data: string): void => {
    terminalRef.current?.write(data)
  }, [])

  const writeln = useCallback((data: string): void => {
    terminalRef.current?.writeln(data)
  }, [])

  const clear = useCallback((): void => {
    terminalRef.current?.clear()
  }, [])

  const focus = useCallback((): void => {
    terminalRef.current?.focus()
  }, [])

  const blur = useCallback((): void => {
    terminalRef.current?.blur()
  }, [])

  const fit = useCallback((): void => {
    try {
      fitAddonRef.current?.fit()
    } catch {
      // Ignore fit errors during rapid resize
    }
  }, [])

  const scrollToBottom = useCallback((): void => {
    terminalRef.current?.scrollToBottom()
  }, [])

  const getCols = useCallback((): number => {
    return terminalRef.current?.cols ?? 80
  }, [])

  const getRows = useCallback((): number => {
    return terminalRef.current?.rows ?? 24
  }, [])

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return

    const terminalSession = createTerminalSession({
      fontFamily,
      fontSize,
      scrollback,
      convertEol: true,
      terminalOptions: {
        lineHeight: 1.2,
        theme: TERMINAL_THEME,
        cursorBlink: true,
        cursorStyle: 'block',
        allowTransparency: false,
        tabStopWidth: 4,
      },
      loadWebLinksAddon: true,
    })

    const terminal = terminalSession.terminal
    terminalRef.current = terminal

    const fitAddon = terminalSession.fitAddon
    fitAddonRef.current = fitAddon

    terminal.open(containerRef.current)

    if (renderer !== 'dom') {
      try {
        const webglAddon = loadWebglAddon(terminal, {
          onContextLoss: () => {
            webglAddon.dispose()
            webglAddonRef.current = null
          }
        })
        webglAddonRef.current = webglAddon
      } catch {
        console.warn('WebGL addon failed to load, falling back to DOM renderer')
      }
    }

    fitAddon.fit()
    isReadyRef.current = true

    if (onData) {
      terminal.onData(onData)
    }

    if (onResize) {
      terminal.onResize(({ cols, rows }) => {
        onResize(cols, rows)
      })
    }

    return () => {
      isReadyRef.current = false
      webglAddonRef.current?.dispose()
      webglAddonRef.current = null
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [fontFamily, fontSize, scrollback, renderer, onData, onResize])

  return {
    terminalRef,
    containerRef,
    isReady: isReadyRef.current,
    write,
    writeln,
    clear,
    focus,
    blur,
    fit,
    scrollToBottom,
    getCols,
    getRows
  }
}
