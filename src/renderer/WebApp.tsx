/* eslint-disable react-refresh/only-export-components, @typescript-eslint/no-explicit-any, no-empty */
import { useEffect, useState, createContext, useContext, useCallback, useRef } from 'react'
import { createWsAdapter } from '@/lib/ws-adapter'
import type { WsAdapter } from '@shared/types/ws.types'
import type { TerminalApi } from '@shared/types/ipc.types'
import { Toaster, toast } from 'sonner'
import {
  Terminal as TerminalIcon,
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

export function WebApp(): React.JSX.Element {
  const [ws, setWs] = useState<WsAdapter | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isLocked, setIsLocked] = useState(false)

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
      <div className="h-screen w-screen overflow-hidden bg-[#0f0f15] font-sans selection:bg-blue-500/20 selection:text-blue-200">
        <Toaster position="top-right" theme="dark" />
        {ws && <TerminalWorkspace ws={ws} />}
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

function TerminalWorkspace({ ws }: { ws: WsAdapter }): React.JSX.Element {
  const terminalApiRef = useRef<any>(null)
  
  interface WebTerminalSession {
    id: string
    remoteId: string | null
    term: any
    fitAddon: any
    projectId: string | null
    shellName: string
    isAttached?: boolean
  }

  const [sessions, setSessions] = useState<WebTerminalSession[]>([])
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [terminalDeps, setTerminalDeps] = useState<{
    Terminal: any
    FitAddon: any
    api: any
  } | null>(null)

  // Remote Workspace State
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeProject, setActiveProject] = useState<Project | null>(null)

  // Files explorer state
  const [showExplorer, setShowExplorer] = useState(true)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [directoryContents, setDirectoryContents] = useState<Map<string, DirectoryEntry[]>>(new Map())
  const [explorerSearch, setExplorerSearch] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)

  // File Preview Modal state
  const [previewFile, setPreviewFile] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [copiedFile, setCopiedFile] = useState(false)


  // Fetch projects list
  const fetchProjects = useCallback(async () => {
    try {
      const result = await ws.invoke<{
        projects: Project[]
        activeProjectId?: string | null
      }>('get_projects')
      
      setProjects(result.projects)
      if (result.activeProjectId) {
        setActiveProjectId(result.activeProjectId)
        const active = result.projects.find(p => p.id === result.activeProjectId) || null
        setActiveProject(active)
      } else if (result.projects.length > 0) {
        setActiveProjectId(result.projects[0].id)
        setActiveProject(result.projects[0])
      }
    } catch (err) {
      console.error('Failed to get remote projects:', err)
    }
  }, [ws])

  // Synchronize on active project changes
  useEffect(() => {
    void fetchProjects()
    
    // Listen for projects/active project changes from desktop client
    const unsubProjects = ws.listen('projects-changed', (payload) => {
      const updatedProjects = payload.projects as Project[] || []
      const activeId = payload.activeProjectId as string || null
      setProjects(updatedProjects)
      setActiveProjectId(activeId)
      const active = updatedProjects.find(p => p.id === activeId) || null
      setActiveProject(active)
    })

    return () => {
      unsubProjects()
    }
  }, [ws, fetchProjects])


  // Load directory items recursively/lazily
  const loadDirectory = useCallback(async (path: string) => {
    try {
      const entries = await ws.invoke<DirectoryEntry[]>('read_directory', { dirPath: path })
      setDirectoryContents(prev => {
        const next = new Map(prev)
        next.set(path, entries)
        return next
      })
    } catch (err) {
      console.error('Failed to read directory:', err)
      toast.error('Failed to read folder contents')
    }
  }, [ws])

  // Initial load of active project root directory
  useEffect(() => {
    if (activeProject?.path) {
      setExpandedDirs(new Set([activeProject.path]))
      void loadDirectory(activeProject.path)
    }
  }, [activeProject?.path, loadDirectory])

  // Expand directory handler
  const handleToggleExpand = useCallback(async (path: string) => {
    const isExpanded = expandedDirs.has(path)
    const next = new Set(expandedDirs)
    if (isExpanded) {
      next.delete(path)
    } else {
      next.add(path)
      if (!directoryContents.has(path)) {
        await loadDirectory(path)
      }
    }
    setExpandedDirs(next)
  }, [expandedDirs, directoryContents, loadDirectory])

  // Select project from drop-down switcher
  const handleSelectProject = useCallback(async (projectId: string) => {
    try {
      const result = await ws.invoke<boolean>('set_active_project', { projectId })
      if (result) {
        setActiveProjectId(projectId)
        const selected = projects.find(p => p.id === projectId) || null
        setActiveProject(selected)
        toast.success(`Switched workspace: ${selected?.name}`)
      }
    } catch (err) {
      console.error('Failed to select active project:', err)
      toast.error('Failed to switch workspace project')
    }
  }, [ws, projects])

  // Refresh active project files
  const handleRefreshWorkspace = useCallback(async () => {
    if (!activeProject?.path) return
    setIsRefreshing(true)
    try {
      // Reload all already expanded folders
      const pathsToReload = Array.from(expandedDirs)
      await Promise.all(pathsToReload.map(p => loadDirectory(p)))
      toast.success('Workspace files reloaded')
    } catch {
      toast.error('Failed to refresh files')
    } finally {
      setIsRefreshing(false)
    }
  }, [activeProject?.path, expandedDirs, loadDirectory])

  // Select file for reading and previewing
  const handleSelectFile = useCallback(async (filePath: string) => {
    setIsPreviewLoading(true)
    setPreviewFile(filePath)
    setPreviewContent(null)
    try {
      const result = await ws.invoke<{ content: string }>('read_file', { filePath })
      setPreviewContent(result.content)
    } catch (err) {
      console.error('Failed to read remote file:', err)
      toast.error('Cannot open file preview')
      setPreviewFile(null)
    } finally {
      setIsPreviewLoading(false)
    }
  }, [ws])

  // Copy Preview content
  const handleCopyPreview = useCallback(async () => {
    if (!previewContent) return
    try {
      await navigator.clipboard.writeText(previewContent)
      setCopiedFile(true)
      toast.success('File content copied to clipboard')
      setTimeout(() => setCopiedFile(false), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }, [previewContent])

  // Load xterm.js and ws-terminal-api dependencies
  useEffect(() => {
    const loadDeps = async () => {
      try {
        const { Terminal } = await import('@xterm/xterm')
        const { FitAddon } = await import('@xterm/addon-fit')
        const { createWsTerminalApi } = await import('@/lib/ws-terminal-api')
        await import('@xterm/xterm/css/xterm.css')
        
        const api = createWsTerminalApi(ws)
        terminalApiRef.current = api
        setTerminalDeps({ Terminal, FitAddon, api })
      } catch (err) {
        console.error('Failed to load terminal dependencies:', err)
        toast.error('Failed to load terminal dependencies')
      }
    }
    void loadDeps()
  }, [ws])

  // Add a new terminal tab session
  const addSession = useCallback(async (projId?: string) => {
    const targetProjId = projId || activeProjectId
    if (!targetProjId || !terminalDeps) return

    const id = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const newSession: WebTerminalSession = {
      id,
      remoteId: null,
      term: null,
      fitAddon: null,
      projectId: targetProjId,
      shellName: 'Terminal'
    }

    setSessions(prev => [...prev, newSession])
    setActiveSessionId(id)
  }, [activeProjectId, terminalDeps])

  // Initialize xterm.js inside the mounted container element
  const initSessionTerminal = useCallback(async (session: WebTerminalSession, el: HTMLDivElement) => {
    if (!terminalDeps) return

    const { Terminal, FitAddon, api } = terminalDeps
    
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
      theme: {
        background: '#0a0a0f',
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
    term.open(el)
    
    // Slight delay to ensure element dimensions are calculated properly
    setTimeout(() => {
      try {
        fitAddon.fit()
      } catch {}
    }, 50)

    session.term = term
    session.fitAddon = fitAddon

    term.onData((data: string) => {
      if (session.remoteId) {
        void api.write(session.remoteId, data)
      }
    })

    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (session.remoteId) {
        void api.resize(session.remoteId, cols, rows)
      }
    })

    term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey) {
        if (ev.key === 'c' || ev.key === 'C') {
          const text = term.getSelection()
          if (text) {
            void navigator.clipboard.writeText(text)
            toast.success('Copied to clipboard')
            return false
          }
        }
        if (ev.key === 'v' || ev.key === 'V') {
          void navigator.clipboard.readText().then(text => {
            if (session.remoteId) {
              void api.write(session.remoteId, text)
            }
          })
          return false
        }
      }
      return true
    })

    const unsubData = api.onData((remoteId: string, data: string) => {
      if (remoteId === session.remoteId) {
        term.write(data)
      }
    })

    const unsubExit = api.onExit((remoteId: string) => {
      if (remoteId === session.remoteId) {
        term.write('\r\n\x1b[33mProcess exited.\x1b[0m\r\n')
      }
    })

    try {
      const proj = projects.find(p => p.id === session.projectId)
      
      // Query for an existing unmapped terminal session on the desktop that we can mirror
      let existingPtyId: string | null = null
      let existingShell: string | null = null
      let isAttached = false
      
      if (ws) {
        try {
          const activeTerminals = await ws.invoke<any[]>('terminal_list')
          console.log(`[RemoteCoding] Queried terminal_list. Found ${activeTerminals?.length || 0} active terminals on desktop:`, activeTerminals)
          
          if (activeTerminals && activeTerminals.length > 0) {
            // Find terminals where the cwd matches this project's path
            const projectTerminals = activeTerminals.filter(t => {
              const pathNormal = t.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
              const projNormal = (proj?.path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
              
              const isMatch = pathNormal === projNormal || pathNormal.startsWith(projNormal + '/')
              console.log(`[RemoteCoding] CWD Match Check: [${t.cwd}] vs [${proj?.path}] -> ${isMatch ? 'MATCH' : 'NO MATCH'}`)
              return isMatch
            })
            
            console.log(`[RemoteCoding] Found ${projectTerminals.length} terminals matching project path.`)
            
            if (projectTerminals.length > 0) {
              // Find one that is not already mapped to an active session in the browser
              const mappedIds = sessionsRef.current.map(s => s.remoteId).filter(Boolean)
              const unmapped = projectTerminals.find(t => !mappedIds.includes(t.id))
              if (unmapped) {
                existingPtyId = unmapped.id
                existingShell = unmapped.shell
                isAttached = true
                console.log(`[RemoteCoding] SUCCESS! Attaching to existing Tauri PTY terminal: ${existingPtyId} (${existingShell})`)
              } else {
                console.log(`[RemoteCoding] All matching terminals are already mapped to active browser tabs. Spawning new one.`)
              }
            }
          }
        } catch (err) {
          console.error('[RemoteCoding] Failed to query terminal_list:', err)
        }
      }

      let result
      if (existingPtyId) {
        result = {
          success: true,
          data: {
            id: existingPtyId,
            shell: existingShell || 'Terminal'
          }
        }
        term.write('\x1b[32m[Connected to live Tauri desktop terminal session]\x1b[0m\r\n')
      } else {
        result = await api.spawn({ cwd: proj?.path })
      }

      if (result.success) {
        session.remoteId = result.data.id
        session.isAttached = isAttached
        const name = result.data.shell ? result.data.shell.split(/[\\/]/).pop() || 'Terminal' : 'Terminal'
        session.shellName = name
        
        // Trigger state refresh for tab title
        setSessions(prev => prev.map(s => s.id === session.id ? { ...s, remoteId: result.data.id, shellName: name, isAttached } : s))
        
        // Fit after spawn to match dimensions
        setTimeout(() => {
          try {
            fitAddon.fit()
            void api.resize(result.data.id, term.cols, term.rows)
          } catch {}
        }, 100)
      } else {
        term.write(`\r\n\x1b[31mSpawn failed: ${result.error}\x1b[0m\r\n`)
      }
    } catch (err) {
      console.error('Failed to spawn remote terminal:', err)
      term.write(`\r\n\x1b[31mFailed to spawn terminal process\x1b[0m\r\n`)
    }

    (session as any).cleanup = () => {
      try {
        unsubData()
        unsubExit()
        term.dispose()
      } catch {}
    }
  }, [terminalDeps, projects, ws])

  // Close a terminal tab session
  const closeSession = useCallback(async (id: string) => {
    const session = sessions.find(s => s.id === id)
    if (!session) return

    setSessions(prev => prev.filter(s => s.id !== id))

    if (activeSessionId === id) {
      const sibling = sessions.find(s => s.id !== id && s.projectId === session.projectId)
      setActiveSessionId(sibling ? sibling.id : null)
    }

    try {
      if ((session as any).cleanup) {
        (session as any).cleanup()
      }
    } catch {}

    if (session.remoteId && terminalDeps?.api && !session.isAttached) {
      try {
        await terminalDeps.api.kill(session.remoteId)
      } catch {}
    }
  }, [sessions, activeSessionId, terminalDeps])

  // Auto-spawn or restore session when active project changes
  useEffect(() => {
    if (!terminalDeps || !activeProjectId) return

    const projectSessions = sessions.filter(s => s.projectId === activeProjectId)
    if (projectSessions.length === 0) {
      void addSession(activeProjectId)
    } else {
      const activeInProject = projectSessions.find(s => s.id === activeSessionId)
      if (!activeInProject) {
        setActiveSessionId(projectSessions[0].id)
      }
    }
  }, [activeProjectId, terminalDeps, sessions, activeSessionId, addSession])

  // Fit terminal on active session changes
  useEffect(() => {
    const activeSession = sessions.find(s => s.id === activeSessionId)
    if (activeSession && activeSession.fitAddon) {
      setTimeout(() => {
        try {
          activeSession.fitAddon.fit()
          if (activeSession.remoteId && terminalDeps?.api) {
            void terminalDeps.api.resize(activeSession.remoteId, activeSession.term.cols, activeSession.term.rows)
          }
        } catch {}
      }, 50)
    }
  }, [activeSessionId, sessions, terminalDeps])

  // Observe active terminal container resize dynamically
  useEffect(() => {
    if (!terminalDeps) return

    const activeSession = sessions.find(s => s.id === activeSessionId)
    if (!activeSession || !activeSession.term || !activeSession.fitAddon) return

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          activeSession.fitAddon.fit()
          if (activeSession.remoteId && terminalDeps.api) {
            const cols = activeSession.term.cols || 80
            const rows = activeSession.term.rows || 24
            void terminalDeps.api.resize(activeSession.remoteId, cols, rows)
          }
        } catch {}
      })
    })

    const activeEl = document.querySelector(`.xterm-container`)
    if (activeEl) {
      resizeObserver.observe(activeEl)
    }

    return () => {
      resizeObserver.disconnect()
    }
  }, [terminalDeps, sessions, activeSessionId])

  // Auto-collapse explorer on mobile screens
  useEffect(() => {
    const handleScreenSize = () => {
      if (window.innerWidth < 768) {
        setShowExplorer(false)
      } else {
        setShowExplorer(true)
      }
    }
    handleScreenSize()
    window.addEventListener('resize', handleScreenSize)
    return () => window.removeEventListener('resize', handleScreenSize)
  }, [])

  return (
    <div className="h-full w-full flex flex-col bg-[#08080c] text-zinc-100 overflow-hidden">
      {/* Sleek top Header */}
      <header className="h-14 flex items-center justify-between px-6 bg-zinc-950/80 backdrop-blur-xl border-b border-zinc-900 shadow-lg shrink-0">
        <div className="flex items-center gap-3 shrink-0">
          <div className="p-2 bg-blue-500/10 rounded-xl border border-blue-500/25">
            <Laptop className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight text-white flex items-center gap-1.5">
              Termul <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 uppercase tracking-widest">Portal</span>
            </h1>
            <p className="text-[10px] text-zinc-500 font-medium">Secure Remote Coding</p>
          </div>
        </div>

        {/* Project Selector Switcher */}
        {projects.length > 0 && (
          <div className="flex items-center gap-2.5 max-w-xs md:max-w-md shrink px-2">
            <span className="hidden sm:inline text-xs text-zinc-500 font-semibold select-none shrink-0 uppercase tracking-wider">Workspace:</span>
            <div className="flex items-center gap-2 relative">
              {activeProject && (
                <span
                  className="w-2 h-2 rounded-full shrink-0 shadow-sm transition-all"
                  style={{
                    backgroundColor: (() => {
                      const map: Record<string, string> = {
                        blue: '#3b82f6',
                        purple: '#a855f7',
                        pink: '#ec4899',
                        red: '#ef4444',
                        orange: '#f97316',
                        yellow: '#eab308',
                        green: '#22c55e',
                        cyan: '#06b6d4',
                        gray: '#6b7280'
                      }
                      return map[activeProject.color] || '#3b82f6'
                    })(),
                    boxShadow: `0 0 8px ${(() => {
                      const map: Record<string, string> = {
                        blue: '#3b82f6',
                        purple: '#a855f7',
                        pink: '#ec4899',
                        red: '#ef4444',
                        orange: '#f97316',
                        yellow: '#eab308',
                        green: '#22c55e',
                        cyan: '#06b6d4',
                        gray: '#6b7280'
                      }
                      return map[activeProject.color] || '#3b82f6'
                    })()}80`
                  }}
                />
              )}
              <div className="relative">
                <select
                  value={activeProjectId || ''}
                  onChange={(e) => handleSelectProject(e.target.value)}
                  className="w-full appearance-none bg-zinc-900 border border-zinc-800 rounded-xl pl-4 pr-9 py-1.5 text-xs text-zinc-200 font-medium focus:ring-1 focus:ring-blue-500/30 focus:border-blue-500 outline-none cursor-pointer hover:bg-zinc-800/80 hover:text-white transition-all shadow-inner"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2.5 text-zinc-500">
                  <ChevronDown size={14} />
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 shrink-0">
          {/* File Explorer Toggle */}
          <button
            onClick={() => setShowExplorer(!showExplorer)}
            className={`p-2 rounded-xl border transition-all ${
              showExplorer
                ? 'bg-blue-500/10 border-blue-500/30 text-blue-400'
                : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-800'
            }`}
            title="Toggle File Explorer"
          >
            <Folder size={16} />
          </button>

          {/* Connected Glow Indicator */}
          <div className="px-3 py-1.5 bg-green-500/10 border border-green-500/20 rounded-xl flex items-center gap-2 shadow-inner">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
            </span>
            <span className="text-[10px] text-green-400 font-bold uppercase tracking-wider hidden sm:inline">Connected</span>
          </div>
        </div>
      </header>

      {/* Main Workspace split panel */}
      <div className="flex-1 flex min-h-0 relative">
        <ResizablePanelGroup direction="horizontal" className="h-full w-full">
          {/* File Explorer Panel */}
          {showExplorer && (
            <ResizablePanel defaultSize={20} minSize={15} maxSize={35} className="bg-zinc-950/65 backdrop-blur-md flex flex-col h-full border-r border-zinc-900">
              <div className="p-4 border-b border-zinc-900 flex items-center justify-between shrink-0">
                <span className="text-xs font-semibold text-zinc-400 uppercase tracking-widest select-none">Explorer</span>
                <button
                  onClick={handleRefreshWorkspace}
                  disabled={isRefreshing}
                  className={`p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800 transition-all ${
                    isRefreshing ? 'animate-spin' : ''
                  }`}
                  title="Refresh Files"
                >
                  <RefreshCw size={13} />
                </button>
              </div>

              {/* Local File Search */}
              <div className="p-3 shrink-0">
                <div className="relative">
                  <input
                    type="text"
                    value={explorerSearch}
                    onChange={(e) => setExplorerSearch(e.target.value)}
                    placeholder="Filter files by name..."
                    className="w-full bg-zinc-900/60 border border-zinc-800 rounded-xl pl-8.5 pr-4 py-1.5 text-xs text-zinc-300 placeholder-zinc-600 focus:ring-1 focus:ring-blue-500/30 focus:border-blue-500 outline-none transition-all shadow-inner"
                  />
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-zinc-600">
                    <Search size={12} />
                  </div>
                  {explorerSearch && (
                    <button
                      onClick={() => setExplorerSearch('')}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-zinc-500 hover:text-white transition-colors"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>

              {/* Recursive File Tree */}
              <div className="flex-1 overflow-y-auto px-2 py-1 space-y-1">
                {activeProject?.path ? (
                  directoryContents.has(activeProject.path) ? (
                    <FileTree
                      ws={ws}
                      dirPath={activeProject.path}
                      level={0}
                      directoryContents={directoryContents}
                      expandedDirs={expandedDirs}
                      searchQuery={explorerSearch}
                      onToggleExpand={handleToggleExpand}
                      onSelectFile={handleSelectFile}
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-center shrink-0">
                      <div className="w-5 h-5 border-2 border-zinc-700 border-t-blue-500 rounded-full animate-spin mb-3" />
                      <span className="text-xs text-zinc-500 font-medium">Mounting directory...</span>
                    </div>
                  )
                ) : (
                  <div className="py-12 text-center text-xs text-zinc-600 italic select-none">
                    Select a workspace to explore files.
                  </div>
                )}
              </div>
            </ResizablePanel>
          )}

          {/* Resize Handle Divider */}
          {showExplorer && <ResizableHandle withHandle={true} className="border-zinc-900 bg-zinc-950/65" />}

          {/* Terminal Panel */}
          <ResizablePanel defaultSize={80} className="bg-[#0a0a0f] flex flex-col h-full min-w-0">
            {/* Elegant Tab Bar */}
            <div className="h-9 bg-zinc-950/60 border-b border-zinc-900 flex items-center justify-between shrink-0 select-none">
              <div className="flex items-center overflow-x-auto h-full scrollbar-none">
                {sessions
                  .filter(s => s.projectId === activeProjectId)
                  .map(s => {
                    const isActive = s.id === activeSessionId
                    return (
                      <div
                        key={s.id}
                        onClick={() => setActiveSessionId(s.id)}
                        className={`h-full px-4 border-r border-zinc-900 flex items-center gap-2 cursor-pointer transition-all ${
                          isActive
                            ? 'bg-[#0a0a0f] text-white font-medium border-t-2 border-t-blue-500'
                            : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/30'
                        }`}
                      >
                        <TerminalIcon size={12} className={isActive ? 'text-blue-400' : 'text-zinc-500'} />
                        <span className="text-xs truncate max-w-[100px]">{s.shellName}</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            void closeSession(s.id)
                          }}
                          className="p-0.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-white transition-colors cursor-pointer"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    )
                  })}
                <button
                  onClick={() => void addSession()}
                  className="h-full px-3 text-zinc-500 hover:text-white hover:bg-zinc-900/30 border-r border-zinc-900 transition-colors cursor-pointer"
                  title="New Terminal Tab"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>

            {/* Terminal Containers */}
            <div className="flex-1 min-h-0 relative p-3">
              {sessions.filter(s => s.projectId === activeProjectId).length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-center">
                  <TerminalIcon size={24} className="text-zinc-600 animate-pulse" />
                  <p className="text-xs text-zinc-500 font-medium">No terminals active in this project</p>
                  <button
                    onClick={() => void addSession()}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold shadow-md transition-all cursor-pointer"
                  >
                    Spawn Terminal
                  </button>
                </div>
              ) : (
                sessions
                  .filter(s => s.projectId === activeProjectId)
                  .map(s => {
                    const isActive = s.id === activeSessionId
                    return (
                      <div
                        key={s.id}
                        style={{ display: isActive ? 'block' : 'none' }}
                        className="h-full w-full"
                      >
                        <div
                          ref={(el) => {
                            if (el && !s.term) {
                              void initSessionTerminal(s, el)
                            }
                          }}
                          className="h-full w-full xterm-container bg-[#0a0a0f]"
                        />
                      </div>
                    )
                  })
              )}
            </div>

            {/* Minimal Footer */}
            <div className="h-6 px-4 bg-zinc-950 border-t border-zinc-900 flex items-center justify-between text-[10px] text-zinc-600 select-none shrink-0 font-medium">
              <div className="flex items-center gap-1">
                <TerminalIcon size={10} className="text-zinc-600" />
                <span>PTY stream active</span>
              </div>
              <span className="font-mono text-zinc-700">Ctrl+Shift+C / Ctrl+Shift+V to Copy/Paste</span>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {/* Premium File Content Preview Modal */}
      {previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/75 backdrop-blur-sm p-4 md:p-8 animate-in fade-in duration-200">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden shadow-2xl animate-in zoom-in-95 duration-200">
            {/* Preview Header */}
            <div className="px-6 py-4 bg-zinc-900/90 border-b border-zinc-800/80 flex justify-between items-center shrink-0">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded-xl">
                  <FileText size={16} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white tracking-tight truncate max-w-xs md:max-w-md">
                    {previewFile.split('/').pop()}
                  </h3>
                  <p className="text-[10px] text-zinc-500 font-mono truncate max-w-xs md:max-w-md mt-0.5">
                    {previewFile}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {previewContent && (
                  <button
                    onClick={handleCopyPreview}
                    className="p-2 bg-zinc-800 hover:bg-zinc-700 hover:text-white rounded-xl border border-zinc-700 text-zinc-400 transition-all active:scale-95 flex items-center justify-center"
                    title="Copy File Content"
                  >
                    {copiedFile ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                  </button>
                )}
                <button
                  onClick={() => {
                    setPreviewFile(null)
                    setPreviewContent(null)
                  }}
                  className="p-2 bg-zinc-800 hover:bg-zinc-700 hover:text-white rounded-xl border border-zinc-700 text-zinc-400 transition-all active:scale-95 flex items-center justify-center"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Preview Content Area */}
            <div className="flex-1 overflow-auto bg-[#0a0a0f] p-6 font-mono text-xs leading-relaxed text-zinc-300">
              {isPreviewLoading ? (
                <div className="h-full flex flex-col items-center justify-center gap-3">
                  <div className="w-6 h-6 border-2 border-zinc-800 border-t-blue-500 rounded-full animate-spin" />
                  <span className="text-xs text-zinc-500 font-medium">Fetching file contents from host...</span>
                </div>
              ) : previewContent !== null ? (
                <pre className="whitespace-pre overflow-x-auto text-[#a6adc8] bg-[#0a0a0f] select-text">
                  <code>{previewContent}</code>
                </pre>
              ) : (
                <div className="h-full flex items-center justify-center text-zinc-600 italic select-none">
                  Empty file or binary preview not supported.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface FileTreeProps {
  ws: WsAdapter
  dirPath: string
  level: number
  directoryContents: Map<string, DirectoryEntry[]>
  expandedDirs: Set<string>
  searchQuery: string
  onToggleExpand: (path: string) => void
  onSelectFile: (path: string) => void
}

function FileTree({
  ws,
  dirPath,
  level,
  directoryContents,
  expandedDirs,
  searchQuery,
  onToggleExpand,
  onSelectFile
}: FileTreeProps): React.JSX.Element {
  const entries = directoryContents.get(dirPath) || []

  // Filter entries locally based on query
  const filteredEntries = entries.filter(entry => {
    if (!searchQuery) return true
    return entry.name.toLowerCase().includes(searchQuery.toLowerCase())
  })

  if (filteredEntries.length === 0 && entries.length > 0 && searchQuery) {
    return <></>
  }

  return (
    <div className="space-y-0.5">
      {filteredEntries.map(entry => {
        const isDirectory = entry.type === 'directory'
        const isExpanded = expandedDirs.has(entry.path)

        return (
          <div key={entry.path}>
            <button
              onClick={() => isDirectory ? onToggleExpand(entry.path) : onSelectFile(entry.path)}
              className="w-full flex items-center py-1.5 px-2 rounded-xl text-xs text-zinc-400 hover:text-white hover:bg-zinc-900/80 transition-colors group text-left cursor-pointer"
              style={{ paddingLeft: `${level * 12 + 8}px` }}
            >
              <span className="mr-1.5 text-zinc-600 group-hover:text-zinc-400 transition-colors shrink-0">
                {isDirectory ? (
                  isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
                ) : (
                  <FileText size={12} className="ml-3 text-zinc-600" />
                )}
              </span>
              {isDirectory && (
                <span className="mr-2 text-blue-400 shrink-0">
                  {isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                </span>
              )}
              <span className="truncate flex-1 font-medium select-none">{entry.name}</span>
            </button>

            {isDirectory && isExpanded && (
              <FileTree
                ws={ws}
                dirPath={entry.path}
                level={level + 1}
                directoryContents={directoryContents}
                expandedDirs={expandedDirs}
                searchQuery={searchQuery}
                onToggleExpand={onToggleExpand}
                onSelectFile={onSelectFile}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
