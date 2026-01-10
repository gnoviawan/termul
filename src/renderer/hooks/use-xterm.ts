import { useRef, useCallback, useEffect } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { TERMINAL_THEME } from '../components/terminal/terminal-config'

export interface UseXtermOptions {
  onData?: (data: string) => void
  onResize?: (cols: number, rows: number) => void
  fontSize?: number
  fontFamily?: string
  scrollback?: number
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
    scrollback = 10000
  } = options

  const terminalRef = useRef<Terminal | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
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

    const terminal = new Terminal({
      fontFamily,
      fontSize,
      lineHeight: 1.2,
      theme: TERMINAL_THEME,
      cursorBlink: true,
      cursorStyle: 'block',
      allowTransparency: false,
      scrollback,
      tabStopWidth: 4,
      convertEol: true
    })

    terminalRef.current = terminal

    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    terminal.loadAddon(fitAddon)

    const webLinksAddon = new WebLinksAddon()
    terminal.loadAddon(webLinksAddon)

    terminal.open(containerRef.current)

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
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [fontFamily, fontSize, scrollback, onData, onResize])

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
