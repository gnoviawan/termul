/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, FileText, Folder, FolderOpen, Laptop, Plus, RefreshCw, Search, Terminal as TerminalIcon, X, ChevronDown, ChevronRight } from 'lucide-react'
import type { WsAdapter } from '@shared/types/ws.types'
import { toast } from 'sonner'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { FileTree } from './web-file-tree'
import { ExplorerPanel, PreviewModal } from './web-terminal-workspace-parts'

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

export function TerminalWorkspace({ ws }: { ws: WsAdapter }): React.JSX.Element {
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
  const terminalContainerRefs = useRef(new Map<string, HTMLDivElement | null>())
  const terminalWrapRefs = useRef(new Map<string, HTMLDivElement | null>())
  const pendingProjectSpawnRef = useRef<string | null>(null)

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [terminalDeps, setTerminalDeps] = useState<{ Terminal: any; FitAddon: any; api: any } | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeProject, setActiveProject] = useState<Project | null>(null)
  const [showExplorer, setShowExplorer] = useState(true)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [directoryContents, setDirectoryContents] = useState<Map<string, DirectoryEntry[]>>(new Map())
  const [explorerSearch, setExplorerSearch] = useState('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [previewFile, setPreviewFile] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [copiedFile, setCopiedFile] = useState(false)

  const totalRemoteTerminalCount = sessions.filter((session) => Boolean(session.remoteId)).length
  const aliveRemoteTerminalCount = useCallback((projectId?: string | null) => sessions.filter((session) => Boolean(session.remoteId) && (!projectId || session.projectId === projectId)).length, [sessions])
  const projectTerminalCount = useCallback((projectId: string) => sessions.filter((session) => session.projectId === projectId && Boolean(session.remoteId)).length, [sessions])

  useEffect(() => {
    if (!activeSessionId) return
    const activeStillExists = sessions.some((session) => session.id === activeSessionId)
    if (!activeStillExists && sessions.length > 0) setActiveSessionId(sessions[0].id)
  }, [activeSessionId, sessions])

  const fetchProjects = useCallback(async () => {
    try {
      const result = await ws.invoke<{ projects: Project[]; activeProjectId?: string | null }>('get_projects')
      setProjects(result.projects)
      if (result.activeProjectId) {
        setActiveProjectId(result.activeProjectId)
        setActiveProject(result.projects.find((p) => p.id === result.activeProjectId) || null)
      } else if (result.projects.length > 0) {
        setActiveProjectId(result.projects[0].id)
        setActiveProject(result.projects[0])
      }
    } catch (err) {
      console.error('Failed to get remote projects:', err)
    }
  }, [ws])

  const reconcileRemoteTerminals = useCallback(async (): Promise<void> => {
    try {
      const activeTerminals = await ws.invoke<any[]>('terminal_list')
      const projectsByPath = new Map(projects.filter((project) => project.path).map((project) => [normalizePath(project.path as string), project.id] as const))
      const remoteIds = new Set((activeTerminals ?? []).map((terminal) => terminal.id))
      setSessions((prev) => {
        const prevByRemoteId = new Map(prev.map((session) => [session.remoteId, session]))
        const nextSessions: WebTerminalSession[] = []
        for (const terminal of activeTerminals ?? []) {
          const existing = prevByRemoteId.get(terminal.id)
          if (existing) {
            nextSessions.push(existing)
            continue
          }
          const terminalProjectId = terminal.cwd ? projectsByPath.get(normalizePath(terminal.cwd)) ?? activeProjectId : activeProjectId
          nextSessions.push({ id: `remote-${terminal.id}`, remoteId: terminal.id, term: null, fitAddon: null, projectId: terminalProjectId, shellName: terminal.shell || 'Terminal', isAttached: true })
        }
        for (const session of prev) if (!session.remoteId || remoteIds.has(session.remoteId)) nextSessions.push(session)
        return nextSessions
      })
    } catch (err) {
      console.error('[RemoteCoding] reconcile failed', err)
    }
  }, [activeProjectId, projects, ws])

  useEffect(() => {
    void fetchProjects()
    const unsubProjects = ws.listen('projects-changed', (payload) => {
      const updatedProjects = (payload.projects as Project[]) || []
      const activeId = (payload.activeProjectId as string) || null
      setProjects(updatedProjects)
      setActiveProjectId(activeId)
      setActiveProject(updatedProjects.find((p) => p.id === activeId) || null)
    })
    const unsubTerminalList = ws.listen('terminal-list-changed', () => { void reconcileRemoteTerminals() })
    void reconcileRemoteTerminals()
    return () => {
      unsubProjects()
      unsubTerminalList()
    }
  }, [ws, fetchProjects, reconcileRemoteTerminals])

  const loadDirectory = useCallback(async (path: string) => {
    try {
      const entries = await ws.invoke<DirectoryEntry[]>('read_directory', { dirPath: path })
      setDirectoryContents((prev) => new Map(prev).set(path, entries))
    } catch (err) {
      console.error('Failed to read directory:', err)
      toast.error('Failed to read folder contents')
    }
  }, [ws])

  useEffect(() => {
    if (activeProject?.path) {
      setExpandedDirs(new Set([activeProject.path]))
      void loadDirectory(activeProject.path)
    }
  }, [activeProject?.path, loadDirectory])

  const handleToggleExpand = useCallback(async (path: string) => {
    const isExpanded = expandedDirs.has(path)
    const next = new Set(expandedDirs)
    if (isExpanded) next.delete(path)
    else {
      next.add(path)
      if (!directoryContents.has(path)) await loadDirectory(path)
    }
    setExpandedDirs(next)
  }, [expandedDirs, directoryContents, loadDirectory])

  const handleSelectProject = useCallback(async (projectId: string) => {
    try {
      const result = await ws.invoke<boolean>('set_active_project', { projectId })
      if (result) {
        setActiveProjectId(projectId)
        const selected = projects.find((p) => p.id === projectId) || null
        setActiveProject(selected)
        toast.success(`Switched workspace: ${selected?.name}`)
      }
    } catch (err) {
      console.error('Failed to select active project:', err)
      toast.error('Failed to switch workspace project')
    }
  }, [ws, projects])

  const handleRefreshWorkspace = useCallback(async () => {
    if (!activeProject?.path) return
    setIsRefreshing(true)
    try {
      await Promise.all(Array.from(expandedDirs).map((p) => loadDirectory(p)))
      toast.success('Workspace files reloaded')
    } catch {
      toast.error('Failed to refresh files')
    } finally {
      setIsRefreshing(false)
    }
  }, [activeProject?.path, expandedDirs, loadDirectory])

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

  const addSession = useCallback(async (projId?: string) => {
    const targetProjId = projId || activeProjectId
    if (!targetProjId || !terminalDeps) return
    const id = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const newSession: WebTerminalSession = { id, remoteId: null, term: null, fitAddon: null, projectId: targetProjId, shellName: 'Terminal' }
    setSessions((prev) => [...prev, newSession])
    pendingProjectSpawnRef.current = targetProjId
    setActiveSessionId(id)
  }, [activeProjectId, terminalDeps])

  const initSessionTerminal = useCallback(async (session: WebTerminalSession, el: HTMLDivElement) => {
    if (!terminalDeps) return
    let disposed = false
    const { Terminal, FitAddon, api } = terminalDeps
    const term = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace', theme: { background: '#0a0a0f', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#585b7066', black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de', brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8' } })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(el)
    requestAnimationFrame(() => {
      try {
        fitAddon.fit()
      } catch {
        // Ignore transient fit errors before layout settles.
      }
      setTimeout(() => {
        try {
          fitAddon.fit()
        } catch {
          // Ignore transient fit errors before layout settles.
        }
      }, 75)
    })
    session.term = term
    session.fitAddon = fitAddon
    term.onData((data: string) => { if (session.remoteId) void api.write(session.remoteId, data) })
    term.onResize(({ cols, rows }: { cols: number; rows: number }) => { if (session.remoteId) void api.resize(session.remoteId, cols, rows) })
    term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
      if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey) {
        if (ev.key === 'c' || ev.key === 'C') {
          const text = term.getSelection()
          if (text) { void navigator.clipboard.writeText(text); toast.success('Copied to clipboard'); return false }
        }
        if (ev.key === 'v' || ev.key === 'V') { void navigator.clipboard.readText().then((text) => { if (session.remoteId) void api.write(session.remoteId, text) }); return false }
      }
      return true
    })
    const unsubData = api.onData((remoteId: string, data: string) => { if (remoteId === session.remoteId) term.write(data) })
    const unsubExit = api.onExit((remoteId: string) => { if (remoteId === session.remoteId) term.write('\r\n\x1b[33mProcess exited.\x1b[0m\r\n') })

    try {
      const proj = projects.find((p) => p.id === session.projectId)
      let existingPtyId: string | null = null
      let existingShell: string | null = null
      let isAttached = false
      const activeTerminals = await ws.invoke<any[]>('terminal_list')
      if (disposed) return
      if (activeTerminals && activeTerminals.length > 0) {
        const projectTerminals = activeTerminals.filter((t) => {
          const pathNormal = t.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
          const projNormal = (proj?.path || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
          return pathNormal === projNormal || pathNormal.startsWith(projNormal + '/')
        })
        if (projectTerminals.length > 0) {
          const mappedIds = sessionsRef.current.map((s) => s.remoteId).filter(Boolean)
          const unmapped = projectTerminals.find((t) => !mappedIds.includes(t.id))
          if (unmapped) { existingPtyId = unmapped.id; existingShell = unmapped.shell; isAttached = true }
        }
      }
      const result = existingPtyId ? { success: true, data: { id: existingPtyId, shell: existingShell || 'Terminal' } } : await api.spawn({ cwd: proj?.path })
      if (result.success) {
        if (disposed) return
        pendingProjectSpawnRef.current = null
        session.remoteId = result.data.id
        session.isAttached = isAttached
        const name = result.data.shell ? result.data.shell.split(/[\\/]/).pop() || 'Terminal' : 'Terminal'
        session.shellName = name
        setSessions((prev) => prev.map((s) => (s.id === session.id ? { ...s, remoteId: result.data.id, shellName: name, isAttached } : s)))
        requestAnimationFrame(() => {
          if (disposed) return
          try {
            fitAddon.fit()
            void api.resize(result.data.id, term.cols, term.rows)
          } catch {
            // Ignore one-frame sizing races during terminal attach.
          }
        })
      } else term.write(`\r\n\x1b[31mSpawn failed: ${result.error}\x1b[0m\r\n`)
    } catch (err) {
      console.error('Failed to spawn remote terminal:', err)
      term.write('\r\n\x1b[31mFailed to spawn terminal process\x1b[0m\r\n')
    }

    ;(session as any).cleanup = () => {
      disposed = true
      try {
        unsubData()
        unsubExit()
        term.dispose()
      } catch {
        // Ignore cleanup errors from already-disposed terminals.
      }
    }
  }, [terminalDeps, projects, ws])

  const closeSession = useCallback(async (id: string) => {
    const session = sessions.find((s) => s.id === id)
    if (!session) return
    const cleanup = (session as any).cleanup as (() => void) | undefined
    if (activeSessionId === id) {
      const sibling = sessions.find((s) => s.id !== id && s.projectId === session.projectId)
      setActiveSessionId(sibling ? sibling.id : null)
    }
    try {
      cleanup?.()
    } catch {
      // Ignore cleanup errors while closing session.
    }
    setSessions((prev) => prev.filter((s) => s.id !== id))
    if (session.remoteId && terminalDeps?.api && !session.isAttached) {
      try {
        await terminalDeps.api.kill(session.remoteId)
      } catch {
        // Ignore remote kill errors for detached or exited terminals.
      }
    }
  }, [sessions, activeSessionId, terminalDeps])

  useEffect(() => {
    if (!terminalDeps || !activeProjectId) return
    const projectSessions = sessions.filter((s) => s.projectId === activeProjectId)
    if (projectSessions.length === 0) {
      if (pendingProjectSpawnRef.current === activeProjectId) return
      pendingProjectSpawnRef.current = activeProjectId
      void addSession(activeProjectId)
    } else {
      pendingProjectSpawnRef.current = null
      if (!projectSessions.find((s) => s.id === activeSessionId)) setActiveSessionId(projectSessions[0].id)
    }
  }, [activeProjectId, terminalDeps, sessions, activeSessionId, addSession])

  useEffect(() => {
    const activeSession = sessions.find((s) => s.id === activeSessionId)
    if (!activeSession?.fitAddon) return
    const timer = window.setTimeout(() => {
      try {
        if ((activeSession.term.cols || 0) < 2 || (activeSession.term.rows || 0) < 2) return
        activeSession.fitAddon.fit()
        if (activeSession.remoteId && terminalDeps?.api) void terminalDeps.api.resize(activeSession.remoteId, activeSession.term.cols, activeSession.term.rows)
      } catch {
        // Ignore resize errors during rapid layout changes.
      }
    }, 50)
    return () => window.clearTimeout(timer)
  }, [activeSessionId, sessions, terminalDeps])

  useEffect(() => {
    const handleScreenSize = () => setShowExplorer(window.innerWidth >= 768)
    handleScreenSize()
    window.addEventListener('resize', handleScreenSize)
    return () => window.removeEventListener('resize', handleScreenSize)
  }, [])

  return (
    <div className="h-full w-full flex flex-col bg-[#08080c] text-zinc-100 overflow-hidden">
      <header className="h-14 flex items-center justify-between px-6 bg-zinc-950/80 backdrop-blur-xl border-b border-zinc-900 shadow-lg shrink-0">
        <div className="flex items-center gap-3 shrink-0">
          <div className="p-2 bg-blue-500/10 rounded-xl border border-blue-500/25"><Laptop className="w-5 h-5 text-blue-400" /></div>
          <div><h1 className="text-sm font-semibold tracking-tight text-white flex items-center gap-1.5">Termul <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/15 text-blue-400 uppercase tracking-widest">Portal</span></h1><p className="text-[10px] text-zinc-500 font-medium">Secure Remote Coding</p></div>
        </div>
        {projects.length > 0 && <div className="flex items-center gap-2.5 max-w-xs md:max-w-md shrink px-2"><span className="hidden sm:inline text-xs text-zinc-500 font-semibold select-none shrink-0 uppercase tracking-wider">Workspace:</span><div className="flex items-center gap-2 relative">{activeProject && <span className="w-2 h-2 rounded-full shrink-0 shadow-sm transition-all" style={{ backgroundColor: '#3b82f6', boxShadow: '0 0 8px #3b82f680' }} />}<div className="relative"><select value={activeProjectId || ''} onChange={(e) => void handleSelectProject(e.target.value)} className="w-full appearance-none bg-zinc-900 border border-zinc-800 rounded-xl pl-4 pr-9 py-1.5 text-xs text-zinc-200 font-medium focus:ring-1 focus:ring-blue-500/30 focus:border-blue-500 outline-none cursor-pointer hover:bg-zinc-800/80 hover:text-white transition-all shadow-inner">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2.5 text-zinc-500"><ChevronDown size={14} /></div></div><span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-2 py-0.5 text-[10px] font-bold text-zinc-300">{activeProjectId ? aliveRemoteTerminalCount(activeProjectId) : 0}</span><span className="rounded-full border border-zinc-800 bg-zinc-900/80 px-2 py-0.5 text-[10px] font-bold text-zinc-300">{totalRemoteTerminalCount}</span></div></div>}
        <div className="flex items-center gap-3 shrink-0"><button onClick={() => setShowExplorer(!showExplorer)} className={`p-2 rounded-xl border transition-all ${showExplorer ? 'bg-blue-500/10 border-blue-500/30 text-blue-400' : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-800'}`} title="Toggle File Explorer"><Folder size={16} /></button><div className="px-3 py-1.5 bg-green-500/10 border border-green-500/20 rounded-xl flex items-center gap-2 shadow-inner"><span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" /></span><span className="text-[10px] text-green-400 font-bold uppercase tracking-wider hidden sm:inline">Connected</span><span className="ml-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-bold text-green-300">{totalRemoteTerminalCount}</span></div></div>
      </header>

      <div className="flex-1 flex min-h-0 relative">
        <ResizablePanelGroup direction="horizontal" className="h-full w-full">
          {showExplorer && <ResizablePanel defaultSize={20} minSize={15} maxSize={35} className="bg-zinc-950/65 backdrop-blur-md flex flex-col h-full border-r border-zinc-900"><ExplorerPanel ws={ws} showExplorer={showExplorer} activeProjectPath={activeProject?.path} directoryContents={directoryContents} expandedDirs={expandedDirs} explorerSearch={explorerSearch} setExplorerSearch={setExplorerSearch} isRefreshing={isRefreshing} onRefreshWorkspace={() => void handleRefreshWorkspace()} onToggleExpand={(path) => void handleToggleExpand(path)} onSelectFile={(path) => void handleSelectFile(path)} /></ResizablePanel>}
          {showExplorer && <ResizableHandle withHandle={true} className="border-zinc-900 bg-zinc-950/65" />}
          <ResizablePanel defaultSize={80} className="bg-[#0a0a0f] flex flex-col h-full min-w-0">
            <div className="h-9 bg-zinc-950/60 border-b border-zinc-900 flex items-center justify-between shrink-0 select-none"><div className="flex items-center overflow-x-auto h-full scrollbar-none">{sessions.filter((s) => s.projectId === activeProjectId).map((s) => { const isActive = s.id === activeSessionId; return <div key={s.id} onClick={() => setActiveSessionId(s.id)} className={`h-full px-4 border-r border-zinc-900 flex items-center gap-2 cursor-pointer transition-all ${isActive ? 'bg-[#0a0a0f] text-white font-medium border-t-2 border-t-blue-500' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/30'}`}><TerminalIcon size={12} className={isActive ? 'text-blue-400' : 'text-zinc-500'} /><span className="text-xs truncate max-w-[100px]">{s.shellName}</span><span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold text-zinc-300">{s.projectId ? projectTerminalCount(s.projectId) : 0}</span><button onClick={(e) => { e.stopPropagation(); void closeSession(s.id) }} className="p-0.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-white transition-colors cursor-pointer"><X size={10} /></button></div> })}<button onClick={() => void addSession()} className="h-full px-3 text-zinc-500 hover:text-white hover:bg-zinc-900/30 border-r border-zinc-900 transition-colors cursor-pointer" title="New Terminal Tab"><Plus size={14} /></button></div></div>
            <div className="flex-1 min-h-0 relative overflow-hidden">{sessions.filter((s) => s.projectId === activeProjectId).length === 0 ? <div className="h-full flex flex-col items-center justify-center gap-3 text-center"><TerminalIcon size={24} className="text-zinc-600 animate-pulse" /><p className="text-xs text-zinc-500 font-medium">No terminals active in this project</p><button onClick={() => void addSession()} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold shadow-md transition-all cursor-pointer">Spawn Terminal</button></div> : sessions.filter((s) => s.projectId === activeProjectId).map((s) => { const isActive = s.id === activeSessionId; return <div key={s.id} style={{ visibility: isActive ? 'visible' : 'hidden', pointerEvents: isActive ? 'auto' : 'none' }} className="absolute inset-0 h-full w-full" ref={(el) => { terminalWrapRefs.current.set(s.id, el) }}><div ref={(el) => { terminalContainerRefs.current.set(s.id, el); if (el && !s.term) void initSessionTerminal(s, el) }} className="h-full w-full xterm-container bg-[#0a0a0f]" /></div> })}</div>
            <div className="h-6 px-4 bg-zinc-950 border-t border-zinc-900 flex items-center justify-between text-[10px] text-zinc-600 select-none shrink-0 font-medium"><div className="flex items-center gap-1"><TerminalIcon size={10} className="text-zinc-600" /><span>PTY stream active</span></div><span className="font-mono text-zinc-700">Ctrl+Shift+C / Ctrl+Shift+V to Copy/Paste</span></div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <PreviewModal previewFile={previewFile} previewContent={previewContent} isPreviewLoading={isPreviewLoading} copiedFile={copiedFile} onCopyPreview={() => void handleCopyPreview()} onClose={() => { setPreviewFile(null); setPreviewContent(null) }} />
    </div>
  )
}
