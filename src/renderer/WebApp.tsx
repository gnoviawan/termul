/* eslint-disable react-refresh/only-export-components */
import { useEffect, useState, createContext, useContext, useCallback, useRef } from 'react'
import { createWsAdapter } from '@/lib/ws-adapter'
import type { WsAdapter } from '@shared/types/ws.types'
import type { TerminalApi } from '@shared/types/ipc.types'
import { Toaster, toast } from 'sonner'
import { BrowserPanel, GitPanel, TunnelPanel } from './web-panels'
import { FileTree } from './web-file-tree'
import { ExplorerPanel, PreviewModal } from './web-terminal-workspace-parts'
import { TerminalWorkspace as WebTerminalWorkspace } from './web-terminal-workspace'
import {
  Terminal as TerminalIcon,
  Globe,
  GitBranch,
  Route,
  Folder,
  FolderOpen,
  FileText,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Search,
  Copy,
  Check,
  X,
  Menu,
  Activity,
  Layers,
  Sparkles,
  Wifi,
  ExternalLink,
  Laptop,
  Plus
} from 'lucide-react'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'

function resolveWsUrl(rawUrl: string): string {
  if (rawUrl.endsWith('/ws')) return rawUrl
  return `${rawUrl.replace(/\/+$/, '')}/ws`
}

const WS_URL = resolveWsUrl(import.meta.env.VITE_WS_URL || 'ws://localhost:9876')
const WS_PROJECT_ID = import.meta.env.VITE_WS_PROJECT_ID || ''
const WS_SESSION_ID = import.meta.env.VITE_WS_SESSION_ID || ''

// Read token lazily at connect time so it always picks up the latest cookie value.
// A module-level constant would be stale after the cookie expires or is refreshed.
function getWsToken(): string {
  if (import.meta.env.VITE_WS_TOKEN) return import.meta.env.VITE_WS_TOKEN as string
  const win = window as typeof window & { AUTH_TOKEN?: string }
  if (win.AUTH_TOKEN) return win.AUTH_TOKEN
  const match = document.cookie.match(/(?:^|; )termul_web_lite_password=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : ''
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

interface Project {
  id: string
  name: string
  color: string
  path?: string
}

interface DirectoryEntry {
  name: string
  path: string
  type: 'directory' | 'file'
  extension?: string
  size?: number
  modifiedAt?: number
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function WebApp(): React.JSX.Element {
  const [ws, setWs] = useState<WsAdapter | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isLocked, setIsLocked] = useState(false)
  const [activeMode, setActiveMode] = useState<'terminal' | 'browser' | 'git' | 'tunnel'>('terminal')
  const [browserUrl, setBrowserUrl] = useState('https://example.com')
  const [browserOpenError, setBrowserOpenError] = useState<string | null>(null)
  const [remoteStatus, setRemoteStatus] = useState<{ httpUrl: string; wsUrl: string; clientCount: number } | null>(null)
  const [browserTabs, setBrowserTabs] = useState<Array<{ id: string; url: string; title: string }>>([])
  const [activeBrowserTabId, setActiveBrowserTabId] = useState<string | null>(null)
  const [tunnelBusy, setTunnelBusy] = useState(false)
  const [shellSummary, setShellSummary] = useState<{ projectName: string; projectPath: string; terminalCount: number; branchCount: number } | null>(null)
  const [projectList, setProjectList] = useState<Array<{ id: string; name: string; path?: string }>>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [projectFiles, setProjectFiles] = useState<Array<{ name: string; path: string; type: 'directory' | 'file' }>>([])

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('termul-web-browser-tabs')
      if (!raw) return
      const parsed = JSON.parse(raw) as Array<{ id: string; url: string; title: string }>
      if (Array.isArray(parsed)) {
        setBrowserTabs(parsed)
        setActiveBrowserTabId(parsed[0]?.id ?? null)
      }
    } catch {
      // ignore stale storage
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem('termul-web-browser-tabs', JSON.stringify(browserTabs))
    } catch {
      // ignore storage errors
    }
  }, [browserTabs])

  const wsRef = useRef<WsAdapter | null>(null)

  // Clear session cookie and reload to login page
  const handleLogout = useCallback(() => {
    console.log('[WebApp] logout — clearing session cookie')
    document.cookie = 'termul_web_lite_password=; Path=/; Max-Age=0; SameSite=Lax'
    wsRef.current?.disconnect()
    wsRef.current = null
    window.location.reload()
  }, [])

  const connect = useCallback(async () => {
    // Disconnect any existing adapter before creating a new one so that a
    // reconnect after unlock always authenticates with the latest token from
    // the cookie (the old adapter captured a potentially stale token).
    if (wsRef.current) {
      wsRef.current.disconnect()
      wsRef.current = null
      setWs(null)
    }

    setIsConnecting(true)
    setError(null)

    const token = getWsToken()
    const maskedToken = token ? `${token.slice(0, 4)}...${token.slice(-4)}` : '(empty)'
    console.log('[WebApp] connect() token from cookie:', maskedToken, '| url:', WS_URL)

    if (!token) {
      console.warn('[WebApp] connect() no token found in cookie — will likely fail auth')
    }

    const adapter = createWsAdapter({
      url: WS_URL,
      authToken: token,
      projectId: WS_PROJECT_ID || undefined,
      sessionId: WS_SESSION_ID || undefined,
      reconnectInterval: 3000,
      maxReconnectAttempts: 20,
    })

    adapter.onDisconnect(() => {
      console.log('[WebApp] adapter disconnected')
      setIsConnected(false)
    })

    try {
      await adapter.connect()
      console.log('[WebApp] session active', {
        url: WS_URL,
        projectId: WS_PROJECT_ID || null,
        sessionId: WS_SESSION_ID || null,
        tokenMasked: maskedToken,
      })
      wsRef.current = adapter
      setWs(adapter)
      setIsConnected(true)
      setIsConnecting(false)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to connect'
      console.error('[WebApp] connect() failed:', msg, '| token was:', maskedToken)
      setError(msg)
      setIsConnecting(false)
    }
  }, [])

  useEffect(() => {
    void connect()
    return () => {
      wsRef.current?.disconnect()
      wsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!ws) return

    let timer = 0
    const refreshRemoteStatus = async (): Promise<void> => {
      try {
        const status = await ws.invoke<{ httpUrl: string; wsUrl: string; clientCount: number }>('ws_server_get_status')
        setRemoteStatus(status)
      } catch {
        setRemoteStatus(null)
      }
    }

    void refreshRemoteStatus()
    timer = window.setInterval(() => {
      void refreshRemoteStatus()
    }, 5000)

    return () => window.clearInterval(timer)
  }, [ws])

  useEffect(() => {
    if (!ws) return

    let mounted = true
    const loadSummary = async (): Promise<void> => {
      try {
        const result = await ws.invoke<{ projects: Array<{ name: string; path?: string }>; activeProjectId: string | null }>('get_projects')
        const activeProject = result.projects[0] ?? null
        const terminals = await ws.invoke<Array<{ gitBranch?: string | null }>>('terminal_list')
        if (!mounted) return
        setProjectList(result.projects.map((project, index) => ({ id: String(index), name: project.name, path: project.path })))
        setSelectedProjectId((prev) => prev ?? (result.activeProjectId ? String(result.activeProjectId) : '0'))
        setShellSummary({
          projectName: activeProject?.name || 'Remote',
          projectPath: activeProject?.path || 'workspace',
          terminalCount: terminals.length,
          branchCount: terminals.filter((item) => Boolean(item.gitBranch)).length,
        })

        if (activeProject?.path) {
          const entries = (await ws.invoke<Array<{ name: string; path: string; type: 'directory' | 'file' }>>('read_directory', { dirPath: activeProject.path })) as Array<{ name: string; path: string; type: 'directory' | 'file' }>
          if (!mounted) return
          setProjectFiles((entries ?? []).slice(0, 60))
        } else {
          setProjectFiles([])
        }
      } catch {
        if (mounted) setShellSummary(null)
      }
    }

    void loadSummary()
    const interval = window.setInterval(() => { void loadSummary() }, 5000)
    return () => {
      mounted = false
      window.clearInterval(interval)
    }
  }, [ws])

  useEffect(() => {
    const handlePointerDown = (): void => {
      if (!ws) return
      console.log('[WebApp] pointerdown -> handover desktop')
      void ws.invoke('ui_lock_handover', { target: 'desktop' })
        .then(() => console.log('[WebApp] handover desktop sent'))
        .catch((error) => console.error('[WebApp] handover desktop failed', error))
    }

    console.log('[WebApp] pointerdown listener attached', { hasWs: Boolean(ws) })
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => {
      console.log('[WebApp] pointerdown listener removed')
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [ws])

  useEffect(() => {
    if (!ws) return

    return ws.listen('ui-lock-handover', (payload) => {
      console.log('[WebApp] ui-lock-handover', payload)
      if (payload.target === 'web') {
        console.log('[WebApp] locked web')
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
        console.log('[WebApp] token-rotated — updating cookie, ttl:', ttlSecs)
        document.cookie = `termul_web_lite_password=${encodeURIComponent(newToken)}; Path=/; Max-Age=${ttlSecs}; SameSite=Lax`
      }
    })
  }, [ws])

  useEffect(() => {
    if (!ws) return

    let refreshTimer: number | null = null
    return ws.listen('terminal-list-changed', (payload) => {
      console.log('[RemoteCoding] terminal-list-changed', payload)
      if (refreshTimer !== null) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        void ws.invoke('terminal_list').catch((err) => {
          console.error('[RemoteCoding] refresh terminal_list failed', err)
        })
      }, 150)
    })
  }, [ws])

  useEffect(() => {
    if (!ws) return

    const interval = window.setInterval(() => {
      void ws.invoke('terminal_list').catch(() => {})
    }, 3000)

    return () => window.clearInterval(interval)
  }, [ws])

  if (isConnecting) {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-foreground">
        <div className="text-center space-y-6 max-w-sm p-8 bg-card rounded-lg border border-border shadow-2xl animate-in fade-in duration-300">
          <div className="relative w-14 h-14 mx-auto">
            <div className="absolute inset-0 border-2 border-primary/20 rounded-full" />
            <div className="absolute inset-0 border-2 border-t-primary rounded-full animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Laptop className="w-5 h-5 text-primary animate-pulse" />
            </div>
          </div>
          <div className="space-y-1.5">
            <h3 className="text-base font-semibold tracking-tight text-foreground">Termul Remote</h3>
            <p className="text-xs text-muted-foreground">
              Connecting to secure runtime server...
            </p>
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

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center h-screen bg-background text-foreground">
        <div className="text-center space-y-6 max-w-md p-8 bg-card rounded-lg border border-border shadow-2xl">
          <div className="w-14 h-14 bg-destructive/10 border border-destructive/20 text-destructive rounded-lg flex items-center justify-center mx-auto">
            <Wifi className="w-6 h-6" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-lg font-semibold text-foreground tracking-tight">Connection Lost</h1>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Cannot connect to Termul host at:
              <code className="block mt-2 bg-secondary p-2 rounded border border-border font-mono text-[11px] text-foreground truncate">
                {WS_URL}
              </code>
            </p>
          </div>
          {error && (
            <div className="p-2.5 bg-destructive/10 border border-destructive/20 rounded-md">
              <p className="text-destructive text-xs font-mono">{error}</p>
            </div>
          )}
          <button
            onClick={() => void connect()}
            className="w-full py-2.5 bg-primary hover:bg-primary/90 text-primary-foreground font-medium rounded-md shadow-sm transition-colors"
          >
            Reconnect
          </button>
          <button
            onClick={handleLogout}
            className="w-full py-2.5 bg-transparent border border-border hover:bg-secondary text-muted-foreground hover:text-foreground font-medium rounded-md transition-colors"
          >
            Logout
          </button>
        </div>
      </div>
    )
  }

  return (
    <WsContext.Provider value={{ ws, isConnected, isConnecting, error }}>
      <div className="h-screen w-screen overflow-hidden bg-background font-sans selection:bg-primary/20 selection:text-primary-foreground">
        <Toaster position="top-right" theme="dark" />
        {ws && (
          <div className="flex h-full">
            <aside className="flex w-12 flex-col items-center gap-1.5 border-r border-border bg-sidebar px-1.5 py-2 text-muted-foreground">
              <button onClick={() => setActiveMode('terminal')} title="Terminal" aria-label="Terminal" className={`rounded-md p-2 transition-colors ${activeMode === 'terminal' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary hover:text-foreground'}`}>
                <TerminalIcon className="h-4 w-4" />
              </button>
              <button onClick={() => setActiveMode('browser')} title="Browser" aria-label="Browser" className={`rounded-md p-2 transition-colors ${activeMode === 'browser' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary hover:text-foreground'}`}>
                <Globe className="h-4 w-4" />
              </button>
              <button onClick={() => setActiveMode('git')} title="Git" aria-label="Git" className={`rounded-md p-2 transition-colors ${activeMode === 'git' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary hover:text-foreground'}`}>
                <GitBranch className="h-4 w-4" />
              </button>
              <button onClick={() => setActiveMode('tunnel')} title="Tunnel" aria-label="Tunnel" className={`rounded-md p-2 transition-colors ${activeMode === 'tunnel' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary hover:text-foreground'}`}>
                <Route className="h-4 w-4" />
              </button>
              <div className="mt-auto flex flex-col items-center gap-1.5 pb-1 text-[10px] text-muted-foreground">
                <div className={`rounded-full px-1.5 py-0.5 ${isConnected ? 'bg-green-500/15 text-green-400' : 'bg-destructive/15 text-destructive'}`}>
                  {isConnected ? 'LIVE' : 'OFF'}
                </div>
                <div className="h-px w-6 bg-border" />
                <div className="text-center leading-tight">{remoteStatus?.clientCount ?? 0}c</div>
              </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex items-center gap-3 border-b border-border bg-sidebar px-4 py-2 text-sm">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-primary" />
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-foreground text-sm">Termul Web</div>
                    <div className="truncate text-[11px] text-muted-foreground">{shellSummary?.projectName || 'Remote shell'}</div>
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded border border-border bg-secondary px-2 py-0.5">{shellSummary?.projectPath || 'workspace'}</span>
                  <span className="rounded border border-border bg-secondary px-2 py-0.5">{shellSummary?.terminalCount ?? 0} terms</span>
                  <span className="rounded border border-border bg-secondary px-2 py-0.5">{shellSummary?.branchCount ?? 0} branches</span>
                </div>
              </header>

              <main className="min-h-0 flex-1">
                {activeMode === 'terminal' && (
                  <div className="flex h-full min-h-0">
                    <div className="w-56 shrink-0 border-r border-border bg-sidebar p-2">
                      <div className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Projects</div>
                      <div className="space-y-0.5">
                        {projectList.map((project) => (
                          <button
                            key={project.id}
                            onClick={() => setSelectedProjectId(project.id)}
                            className={`w-full rounded-md px-2.5 py-1.5 text-left transition-colors ${selectedProjectId === project.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}`}
                          >
                            <div className="truncate text-xs font-medium">{project.name}</div>
                            <div className="truncate text-[10px] text-muted-foreground/60">{project.path || 'workspace'}</div>
                          </button>
                        ))}
                        {projectList.length === 0 && <div className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground">No projects</div>}
                      </div>
                      <div className="mt-3 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Files</div>
                      <div className="mt-1.5 max-h-[50vh] overflow-auto rounded-md bg-background/50 p-1 text-xs">
                        {projectFiles.map((entry) => (
                          <button
                            key={entry.path}
                            onClick={() => {
                              if (entry.type === 'directory') {
                                void ws.invoke<Array<{ name: string; path: string; type: 'directory' | 'file' }>>('read_directory', { dirPath: entry.path }).then((entries) => setProjectFiles((entries ?? []).slice(0, 60))).catch(() => {})
                              }
                            }}
                            className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-foreground hover:bg-secondary/50 transition-colors"
                          >
                            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${entry.type === 'directory' ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
                            <span className="truncate">{entry.name}</span>
                          </button>
                        ))}
                        {projectFiles.length === 0 && <div className="px-2 py-1 text-muted-foreground">No files</div>}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <WebTerminalWorkspace ws={ws} />
                    </div>
                  </div>
                )}
                {activeMode === 'browser' && (
                  <BrowserPanel
                    browserUrl={browserUrl}
                    setBrowserUrl={setBrowserUrl}
                    browserOpenError={browserOpenError}
                    setBrowserOpenError={setBrowserOpenError}
                    browserTabs={browserTabs}
                    setBrowserTabs={setBrowserTabs}
                    activeBrowserTabId={activeBrowserTabId}
                    setActiveBrowserTabId={setActiveBrowserTabId}
                  />
                )}
                {activeMode === 'git' && <GitPanel ws={ws} />}
                {activeMode === 'tunnel' && <TunnelPanel ws={ws} remoteStatus={remoteStatus} />}
              </main>

              <footer className="flex items-center gap-3 border-t border-border bg-sidebar px-3 py-1.5 text-[10px] text-muted-foreground">
                <span>{isConnected ? 'connected' : 'offline'}</span>
                <span className="text-muted-foreground/40">|</span>
                <span>{activeMode}</span>
                <span className="text-muted-foreground/40">|</span>
                <span>{remoteStatus?.clientCount ?? 0} client</span>
                {error && (
                  <>
                    <span className="text-muted-foreground/40">|</span>
                    <span className="truncate text-destructive">{error}</span>
                  </>
                )}
              </footer>
            </div>
          </div>
        )}
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



