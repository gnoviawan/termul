/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState, createContext, useContext, useCallback, useRef } from 'react'
import { createWsAdapter } from '@/lib/ws-adapter'
import type { WsAdapter } from '@shared/types/ws.types'
import { Toaster } from 'sonner'
import { Wifi, Laptop } from 'lucide-react'
import { RouterProvider } from 'react-router-dom'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'
import { router } from './app-router'

function resolveWsUrl(rawUrl: string): string {
  if (rawUrl.endsWith('/ws')) return rawUrl
  return `${rawUrl.replace(/\/+$/, '')}/ws`
}

const WS_URL = resolveWsUrl(import.meta.env.VITE_WS_URL || 'ws://127.0.0.1:9876')

function getWsToken(): string {
  if (import.meta.env.VITE_WS_TOKEN) return import.meta.env.VITE_WS_TOKEN as string
  const win = window as typeof window & { AUTH_TOKEN?: string }
  if (win.AUTH_TOKEN) return win.AUTH_TOKEN
  const match = document.cookie.match(/(?:^|; )termul_web_lite_password=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

function getWsSessionId(): string {
  if (import.meta.env.VITE_WS_SESSION_ID) return import.meta.env.VITE_WS_SESSION_ID as string
  const win = window as typeof window & { TERMUL_SESSION_ID?: string }
  return win.TERMUL_SESSION_ID || ''
}

function getWsProjectId(): string {
  if (import.meta.env.VITE_WS_PROJECT_ID) return import.meta.env.VITE_WS_PROJECT_ID as string
  const win = window as typeof window & { TERMUL_ACTIVE_PROJECT_ID?: string }
  return win.TERMUL_ACTIVE_PROJECT_ID || ''
}

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
  const [isLocked, setIsLocked] = useState(false)
  const wsRef = useRef<WsAdapter | null>(null)

  const handleLogout = useCallback(() => {
    document.cookie = 'termul_web_lite_password=; Path=/; Max-Age=0; SameSite=Lax'
    if (wsRef.current) {
      wsRef.current.disconnect()
      wsRef.current = null
    }
    delete (window as unknown as Record<string, unknown>).__WS_ADAPTER__
    window.location.reload()
  }, [])

  const connect = useCallback(async () => {
    if (wsRef.current) {
      wsRef.current.disconnect()
      wsRef.current = null
      delete (window as unknown as Record<string, unknown>).__WS_ADAPTER__
      setWs(null)
    }

    setIsConnecting(true)
    setError(null)

    const token = getWsToken()
    const projectId = getWsProjectId()
    const sessionId = getWsSessionId()

    const adapter = createWsAdapter({
      url: WS_URL,
      authToken: token,
      projectId: projectId || undefined,
      sessionId: sessionId || undefined,
      reconnectInterval: 3000,
      maxReconnectAttempts: 20,
    })

    adapter.onDisconnect(() => {
      setIsConnected(false)
    })

    try {
      await adapter.connect()
      ;(window as unknown as Record<string, unknown>).__WS_ADAPTER__ = adapter
      wsRef.current = adapter
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
      if (wsRef.current) {
        wsRef.current.disconnect()
        wsRef.current = null
      }
      delete (window as unknown as Record<string, unknown>).__WS_ADAPTER__
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load projects from backend via WebSocket so WorkspaceLayout doesn't stay stuck loading
  useEffect(() => {
    if (!ws) return
    void ws.invoke<{ projects: Array<Record<string, unknown>>; activeProjectId?: string }>('get_projects')
      .then((res) => {
        const { projects, activeProjectId } = res ?? {}
        useProjectStore.getState().setProjects((projects ?? []) as unknown as Project[], activeProjectId)
      })
      .catch(console.error)
  }, [ws])

  useEffect(() => {
    if (!ws) return
    return ws.listen('projects-changed', (payload) => {
      const projects = Array.isArray(payload.projects) ? payload.projects : []
      const activeProjectId = typeof payload.activeProjectId === 'string' ? payload.activeProjectId : undefined
      useProjectStore.getState().setProjects(projects as Project[], activeProjectId)
    })
  }, [ws])

  useEffect(() => {
    const handlePointerDown = (): void => {
      if (!ws) return
      void ws.invoke('ui_lock_handover', { target: 'desktop' }).catch(() => {})
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [ws])

  useEffect(() => {
    if (!ws) return
    return ws.listen('ui-lock-handover', (payload) => {
      if (payload.target === 'web') {
        setIsLocked(true)
      }
    })
  }, [ws])

  useEffect(() => {
    if (!ws) return
    return ws.listen('token-rotated', (payload) => {
      const newToken = payload.token as string | undefined
      const ttlSecs = (payload.ttlSecs as number | undefined) ?? 900
      if (newToken) {
        document.cookie = `termul_web_lite_password=${encodeURIComponent(newToken)}; Path=/; Max-Age=${ttlSecs}; SameSite=Lax`
      }
    })
  }, [ws])

  if (isConnecting) {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-foreground">
        <div className="text-center space-y-6 max-w-sm p-8 bg-card rounded-lg border border-border shadow-2xl">
          <div className="relative w-14 h-14 mx-auto">
            <div className="absolute inset-0 border-2 border-primary/20 rounded-full" />
            <div className="absolute inset-0 border-2 border-t-primary rounded-full animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Laptop className="w-5 h-5 text-primary animate-pulse" />
            </div>
          </div>
          <div className="space-y-1.5">
            <h3 className="text-base font-semibold tracking-tight text-foreground">Termul Remote</h3>
            <p className="text-xs text-muted-foreground">Connecting to secure runtime server...</p>
          </div>
          {error && (
            <div className="p-2.5 bg-destructive/10 border border-destructive/20 rounded-md">
              <p className="text-destructive text-xs font-mono">{error}</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (!ws) {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-foreground p-6">
        <div className="max-w-sm text-center space-y-4">
          <h3 className="text-base font-semibold">Web Lite offline</h3>
          <p className="text-sm text-muted-foreground">
            {error || 'No websocket connection.'}
          </p>
          <button
            onClick={() => void connect()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <WsContext.Provider value={{ ws, isConnected, isConnecting, error }}>
      <div className="h-screen w-screen overflow-hidden bg-background font-sans selection:bg-primary/20 selection:text-primary-foreground">
        <Toaster position="top-right" theme="dark" />
        {!isLocked && <RouterProvider router={router} />}
        {isLocked && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md">
            <div className="w-full max-w-md rounded-lg border border-border bg-card p-8 text-center shadow-2xl">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
                <Wifi className="w-5 h-5 text-primary" />
              </div>
              <h2 className="text-lg font-semibold text-foreground">Web Lite Locked</h2>
              <p className="mt-1.5 text-xs text-muted-foreground">Desktop took over. Click below to reclaim web access.</p>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setIsLocked(false)
                  void connect()
                }}
                className="mt-6 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Open Web Lite
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleLogout()
                }}
                className="mt-2 w-full rounded-md border border-border hover:bg-secondary px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              >
                Logout
              </button>
            </div>
          </div>
        )}
      </div>
    </WsContext.Provider>
  )
}
