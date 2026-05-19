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

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:9876'
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
      <div className="flex items-center justify-center h-screen bg-[#0f0f15] text-zinc-300">
        <div className="text-center space-y-6 max-w-sm p-8 bg-zinc-900/50 rounded-3xl border border-zinc-800/80 shadow-2xl backdrop-blur-md animate-in fade-in duration-300">
          <div className="relative w-16 h-16 mx-auto">
            <div className="absolute inset-0 border-4 border-blue-500/20 rounded-full" />
            <div className="absolute inset-0 border-4 border-t-blue-500 rounded-full animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Laptop className="w-6 h-6 text-blue-400 animate-pulse" />
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-semibold tracking-tight text-white">Termul Remote</h3>
            <p className="text-sm text-zinc-400 leading-normal">
              Connecting to secure runtime server endpoint...
            </p>
          </div>
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/25 rounded-2xl">
              <p className="text-red-400 text-xs font-mono">{error}</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0f0f15] text-zinc-300">
        <div className="text-center space-y-6 max-w-md p-8 bg-zinc-900/50 rounded-3xl border border-zinc-800/80 shadow-2xl backdrop-blur-md">
          <div className="w-16 h-16 bg-red-500/10 border border-red-500/20 text-red-500 rounded-2xl flex items-center justify-center mx-auto text-3xl animate-bounce">
            🔌
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-bold text-white tracking-tight">Connection Severed</h1>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Cannot establish WebSocket tunnel link to Termul host at:
              <code className="block mt-2 bg-zinc-950 p-2.5 rounded-xl border border-zinc-800 font-mono text-xs text-zinc-300 truncate">
                {WS_URL}
              </code>
            </p>
          </div>
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/25 rounded-2xl">
              <p className="text-red-400 text-xs font-mono">{error}</p>
            </div>
          )}
          <button
            onClick={() => void connect()}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 active:scale-[0.98] text-white font-semibold rounded-2xl shadow-lg shadow-blue-600/15 transition-all"
          >
            Reconnect Session
          </button>
          <button
            onClick={handleLogout}
            className="w-full py-3 bg-transparent border border-zinc-700 hover:border-zinc-500 active:scale-[0.98] text-zinc-400 hover:text-zinc-200 font-semibold rounded-2xl transition-all"
          >
            Logout
          </button>
        </div>
      </div>
    )
  }

  return (
    <WsContext.Provider value={{ ws, isConnected, isConnecting, error }}>
      <div className="h-screen w-screen overflow-hidden bg-[#0a0a0f] font-sans selection:bg-blue-500/20 selection:text-blue-200">
        <Toaster position="top-right" theme="dark" />
        {ws && (
          <div className="flex h-full">
            <aside className="flex w-16 flex-col items-center gap-2 border-r border-zinc-800 bg-zinc-950/95 px-2 py-3 text-zinc-400">
              <button onClick={() => setActiveMode('terminal')} title="Terminal" aria-label="Terminal" className={`rounded-2xl p-3 ${activeMode === 'terminal' ? 'bg-blue-600 text-white' : 'bg-zinc-900 hover:bg-zinc-800'}`}>
                <TerminalIcon className="h-4 w-4" />
              </button>
              <button onClick={() => setActiveMode('browser')} title="Browser" aria-label="Browser" className={`rounded-2xl p-3 ${activeMode === 'browser' ? 'bg-blue-600 text-white' : 'bg-zinc-900 hover:bg-zinc-800'}`}>
                <Globe className="h-4 w-4" />
              </button>
              <button onClick={() => setActiveMode('git')} title="Git" aria-label="Git" className={`rounded-2xl p-3 ${activeMode === 'git' ? 'bg-blue-600 text-white' : 'bg-zinc-900 hover:bg-zinc-800'}`}>
                <GitBranch className="h-4 w-4" />
              </button>
              <button onClick={() => setActiveMode('tunnel')} title="Tunnel" aria-label="Tunnel" className={`rounded-2xl p-3 ${activeMode === 'tunnel' ? 'bg-blue-600 text-white' : 'bg-zinc-900 hover:bg-zinc-800'}`}>
                <Route className="h-4 w-4" />
              </button>
              <div className="mt-auto flex flex-col items-center gap-2 pb-2 text-[10px] text-zinc-500">
                <div className="rounded-full bg-emerald-500/15 px-2 py-1 text-emerald-300">{isConnected ? 'LIVE' : 'OFF'}</div>
                <div className="h-px w-8 bg-zinc-800" />
                <div className="text-center leading-tight">{remoteStatus?.clientCount ?? 0}c</div>
              </div>
            </aside>

            <div className="flex min-w-0 flex-1 flex-col">
              <header className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-950/90 px-4 py-3 text-sm text-zinc-300">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="h-2.5 w-2.5 rounded-full bg-blue-500 shadow-[0_0_12px_rgba(59,130,246,0.7)]" />
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-white">Termul Web</div>
                    <div className="truncate text-xs text-zinc-500">{shellSummary?.projectName || 'Remote shell'}</div>
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-3 text-xs text-zinc-400">
                  <div className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1">{shellSummary?.projectPath || 'workspace'}</div>
                  <div className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1">{shellSummary?.terminalCount ?? 0} terminals</div>
                  <div className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1">{shellSummary?.branchCount ?? 0} branches</div>
                  <div className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1">{remoteStatus?.wsUrl || WS_URL}</div>
                </div>
              </header>

              <main className="min-h-0 flex-1">
                {activeMode === 'terminal' && (
                  <div className="flex h-full min-h-0">
                    <div className="w-72 shrink-0 border-r border-zinc-800 bg-zinc-950/70 p-3">
                      <div className="mb-3 text-xs uppercase tracking-wider text-zinc-500">Projects</div>
                      <div className="space-y-1">
                        {projectList.map((project) => (
                          <button
                            key={project.id}
                            onClick={() => setSelectedProjectId(project.id)}
                            className={`w-full rounded-2xl px-3 py-2 text-left ${selectedProjectId === project.id ? 'bg-blue-600 text-white' : 'bg-zinc-900 text-zinc-300 hover:bg-zinc-800'}`}
                          >
                            <div className="truncate text-sm font-medium">{project.name}</div>
                            <div className="truncate text-xs opacity-70">{project.path || 'workspace'}</div>
                          </button>
                        ))}
                        {projectList.length === 0 && <div className="rounded-2xl bg-zinc-900 px-3 py-2 text-sm text-zinc-500">No projects</div>}
                      </div>
                      <div className="mt-4 text-xs uppercase tracking-wider text-zinc-500">Files</div>
                      <div className="mt-2 max-h-[50vh] overflow-auto rounded-2xl bg-zinc-900/80 p-2 text-sm text-zinc-300">
                        {projectFiles.map((entry) => (
                          <button
                            key={entry.path}
                            onClick={() => {
                              if (entry.type === 'directory') {
                                void ws.invoke<Array<{ name: string; path: string; type: 'directory' | 'file' }>>('read_directory', { dirPath: entry.path }).then((entries) => setProjectFiles((entries ?? []).slice(0, 60))).catch(() => {})
                              }
                            }}
                            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-zinc-800"
                          >
                            <span className={`h-2 w-2 rounded-full ${entry.type === 'directory' ? 'bg-blue-400' : 'bg-zinc-500'}`} />
                            <span className="truncate">{entry.name}</span>
                          </button>
                        ))}
                        {projectFiles.length === 0 && <div className="px-3 py-2 text-zinc-500">No files</div>}
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

              <footer className="flex items-center gap-3 border-t border-zinc-800 bg-zinc-950/90 px-4 py-2 text-[11px] text-zinc-500">
                <span>{isConnected ? 'connected' : 'offline'}</span>
                <span>mode {activeMode}</span>
                <span>{remoteStatus?.clientCount ?? 0} client</span>
                <span className="truncate">{error || 'stable'}</span>
              </footer>
            </div>
          </div>
        )}
        {isLocked && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md">
            <div className="w-full max-w-md rounded-3xl border border-zinc-800 bg-zinc-950/95 p-8 text-center shadow-2xl">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-blue-500/20 bg-blue-500/10 text-2xl">🔒</div>
              <h2 className="text-xl font-semibold text-white">Web Lite Locked</h2>
              <p className="mt-2 text-sm text-zinc-400">Klik di web lite kirim lock ke desktop. Klik Open buat buka lagi.</p>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setIsLocked(false)
                  void connect()
                }}
                className="mt-6 w-full rounded-2xl bg-blue-600 px-4 py-3 font-semibold text-white transition-colors hover:bg-blue-500"
              >
                Open Web Lite
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  handleLogout()
                }}
                className="mt-3 w-full rounded-2xl border border-zinc-700 hover:border-zinc-500 px-4 py-3 font-semibold text-zinc-400 hover:text-zinc-200 transition-colors"
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



