/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState, createContext, useContext, useCallback, useRef } from 'react'
import { createWsAdapter } from '@/lib/ws-adapter'
import type { WsAdapter } from '@shared/types/ws.types'
import type { TerminalApi } from '@shared/types/ipc.types'
import { Toaster } from 'sonner'

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:9876'
const WS_TOKEN = import.meta.env.VITE_WS_TOKEN || ''

interface WsContextValue {
  ws: WsAdapter | null
  isConnected: boolean
  isConnecting: boolean
  error: string | null
}

const WsContext = createContext<WsContextValue>({
  ws: null,
  isConnected: false,
  isConnecting: false,
  error: null,
})

export function useWsContext(): WsContextValue {
  return useContext(WsContext)
}

export { WsContext }

export function WebApp(): React.JSX.Element {
  const [ws, setWs] = useState<WsAdapter | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(async () => {
    setIsConnecting(true)
    setError(null)

    const adapter = createWsAdapter({
      url: WS_URL,
      authToken: WS_TOKEN,
      reconnectInterval: 3000,
      maxReconnectAttempts: 20,
    })

    adapter.onDisconnect(() => {
      setIsConnected(false)
    })

    try {
      await adapter.connect()
      setWs(adapter)
      setIsConnected(true)
      setIsConnecting(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect')
      setIsConnecting(false)
    }
  }, [])

  useEffect(() => {
    void connect()
    return () => {
      ws?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (isConnecting) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center space-y-4">
          <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin mx-auto" />
          <p className="text-muted-foreground">Connecting to Termul server...</p>
          {error && <p className="text-red-500 text-sm">{error}</p>}
        </div>
      </div>
    )
  }

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center space-y-4 max-w-md px-6">
          <div className="text-4xl">🔌</div>
          <h1 className="text-xl font-bold">Connection Lost</h1>
          <p className="text-muted-foreground text-sm">
            Cannot connect to Termul server at <code className="bg-muted px-1 rounded">{WS_URL}</code>
          </p>
          {error && <p className="text-red-500 text-xs">{error}</p>}
          <button
            onClick={() => void connect()}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
          >
            Retry Connection
          </button>
        </div>
      </div>
    )
  }

  return (
    <WsContext.Provider value={{ ws, isConnected, isConnecting, error }}>
      <div className="h-screen w-screen overflow-hidden bg-background">
        <Toaster position="top-right" />
        {ws && <TerminalWorkspace ws={ws} />}
      </div>
    </WsContext.Provider>
  )
}

function TerminalWorkspace({ ws }: { ws: WsAdapter }): React.JSX.Element {
  const terminalApiRef = useRef<TerminalApi | null>(null)
  const terminalIdRef = useRef<string | null>(null)
  const [termEl, setTermEl] = useState<HTMLDivElement | null>(null)
  const cleanupRef = useRef<{
    unsubData?: () => void
    unsubExit?: () => void
    unsubCwd?: () => void
    term?: { dispose: () => void }
    fitAddon?: { fit: () => void }
  } | null>(null)

  useEffect(() => {
    let cancelled = false

    const init = async () => {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      const { createWsTerminalApi } = await import('@/lib/ws-terminal-api')

      if (cancelled || !termEl) return

      const api = createWsTerminalApi(ws)
      terminalApiRef.current = api

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'JetBrains Mono, Fira Code, monospace',
        theme: {
          background: '#1e1e2e',
          foreground: '#cdd6f4',
          cursor: '#f5e0dc',
          selectionBackground: '#585b7066',
          black: '#45475a',
          red: '#f38ba8',
          green: '#a6e3a1',
          yellow: '#f9e2af',
          blue: '#89b4fa',
          magenta: '#f5c2e7',
          cyan: '#94e2d5',
          white: '#bac2de',
          brightBlack: '#585b70',
          brightRed: '#f38ba8',
          brightGreen: '#a6e3a1',
          brightYellow: '#f9e2af',
          brightBlue: '#89b4fa',
          brightMagenta: '#f5c2e7',
          brightCyan: '#94e2d5',
          brightWhite: '#a6adc8',
        },
      })

      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(termEl)
      fitAddon.fit()

      term.onData((data) => {
        if (terminalIdRef.current) {
          void api.write(terminalIdRef.current, data)
        }
      })

      term.onResize(({ cols, rows }) => {
        if (terminalIdRef.current) {
          void api.resize(terminalIdRef.current, cols, rows)
        }
      })

      const unsubData = api.onData((_terminalId, data) => {
        if (_terminalId === terminalIdRef.current) {
          term.write(data)
        }
      })

      const unsubExit = api.onExit((_terminalId) => {
        if (_terminalId === terminalIdRef.current) {
          term.write('\r\n\x1b[33mProcess exited.\x1b[0m\r\n')
        }
      })

      const unsubCwd = api.onCwdChanged(() => {})

      cleanupRef.current = { unsubData, unsubExit, unsubCwd, term, fitAddon }

      const result = await api.spawn({})
      if (result.success) {
        terminalIdRef.current = result.data.id
      } else {
        term.write(`\r\n\x1b[31mFailed to spawn terminal: ${result.error}\x1b[0m\r\n`)
      }
    }

    void init()

    return () => {
      cancelled = true
      cleanupRef.current?.unsubData?.()
      cleanupRef.current?.unsubExit?.()
      cleanupRef.current?.unsubCwd?.()
      cleanupRef.current?.term?.dispose()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termEl])

  useEffect(() => {
    if (!cleanupRef.current?.fitAddon) return
    cleanupRef.current.fitAddon.fit()
  }, [])

  return (
    <div className="h-full w-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b">
        <span className="text-sm font-medium">Termul Web</span>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-xs text-muted-foreground">Connected</span>
        </div>
      </div>
      <div ref={setTermEl} className="flex-1" />
    </div>
  )
}
