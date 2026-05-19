import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Globe,
  Terminal,
  Copy,
  Wifi,
  WifiOff,
  RefreshCw,
  Clock,
  FileText,
  Link,
  Shield,
  ExternalLink,
  Zap,
  Activity,
  Layers,
  Eye,
  EyeOff
} from 'lucide-react'
import { useWsServerStore } from '@/stores/ws-server-store'
import { useActiveProject } from '@/stores/project-store'
import { useTunnelStore } from '@/stores/tunnel-store'
import { tunnelApi } from '@/lib/tunnel-api'
import { wsServerApi } from '@/lib/ws-server-api'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { ConnectionAudit } from '@/lib/ws-server-api'
import { listen } from '@tauri-apps/api/event'

const WS_PORT = 9876
const TUNNEL_ID = 'termul-web-tunnel'

export function RemoteAccessPanel(): React.JSX.Element {
  const {
    status: wsStatus,
    isLoading: wsLoading,
    authToken,
    tokenExpiry,
    startServer: startWsServer,
    stopServer: stopWsServer,
    generateToken,
    rotateToken,
    refreshStatus: refreshWsStatus
  } = useWsServerStore()
  const activeProject = useActiveProject()
  const tunnelSessions = useTunnelStore((state) => state.sessions)
  const startTunnel = useTunnelStore((state) => state.startTunnel)
  const stopTunnel = useTunnelStore((state) => state.stopTunnel)
  const tunnelError = useTunnelStore((state) => state.error)

  const [useHttps, setUseHttps] = useState(false)
  const [acknowledgeRemoteAccess, setAcknowledgeRemoteAccess] = useState(false)
  const [webLitePassword, setWebLitePassword] = useState(authToken ?? '')
  const [showWebLitePassword, setShowWebLitePassword] = useState(false)
  const [auditLog, setAuditLog] = useState<ConnectionAudit[]>([])
  const [showAuditLog, setShowAuditLog] = useState(false)
  const [isTunnelStarting, setIsTunnelStarting] = useState(false)
  const [runtimeStream, setRuntimeStream] = useState<Array<{ type: 'system' | 'data' | 'exit' | 'cwd' | 'git'; text: string }>>([])
  const runtimeStreamRef = useRef<HTMLDivElement | null>(null)
  const [pauseAutoscroll, setPauseAutoscroll] = useState(false)

  const activeTunnel = useMemo(
    () => tunnelSessions.find((s) => s.id === TUNNEL_ID) ?? null,
    [tunnelSessions]
  )

  const publicUrl = useMemo(() => {
    if (activeTunnel?.status === 'running' && activeTunnel?.publicUrl) {
      return activeTunnel.publicUrl
    }
    return null
  }, [activeTunnel])

  useEffect(() => {
    void refreshWsStatus()
    const unsubWs = wsServerApi.onStatusChanged((status) => {
      useWsServerStore.setState({ status })
    })
    const unsub = tunnelApi.onStatusChanged((event) => {
      if (event.tunnelId === TUNNEL_ID) {
        if (event.status === 'running' && event.publicUrl) {
          setIsTunnelStarting(false)
          // Sink ke store agar state tersinkronisasi
          useTunnelStore.getState().upsertSession({
            id: TUNNEL_ID,
            configId: TUNNEL_ID,
            status: 'running',
            publicUrl: event.publicUrl,
            lastError: null
          })
          toast.success('Tunnel ready: ' + event.publicUrl)
        } else if (event.status === 'error' || event.status === 'stopped') {
          setIsTunnelStarting(false)
        }
      }
    })
    return () => {
      unsubWs()
      unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const unlistenPromise = listen<{ id: string; data: string }>('terminal-data', ({ payload }) => {
      setRuntimeStream((prev) => {
        const next = [...prev, { type: 'data' as const, text: `[${payload.id}] ${payload.data}` }]
        return next.slice(-120)
      })
    })

    const unlistenExitPromise = listen<{ id: string; exitCode?: number | null }>('terminal-exit', ({ payload }) => {
      setRuntimeStream((prev) => {
        const next = [...prev, { type: 'exit' as const, text: `[${payload.id}] exited ${payload.exitCode ?? 'unknown'}` }]
        return next.slice(-120)
      })
    })

    const unlistenCwdPromise = listen<{ id: string; cwd?: string | null }>('terminal-cwd-changed', ({ payload }) => {
      setRuntimeStream((prev) => {
        const next = [...prev, { type: 'cwd' as const, text: `[${payload.id}] cwd ${payload.cwd ?? 'unknown'}` }]
        return next.slice(-120)
      })
    })

    const unlistenBranchPromise = listen<{ id: string; branch?: string | null }>('terminal-git-branch-changed', ({ payload }) => {
      setRuntimeStream((prev) => {
        const next = [...prev, { type: 'git' as const, text: `[${payload.id}] git ${payload.branch ?? 'unknown'}` }]
        return next.slice(-120)
      })
    })

    return () => {
      void unlistenPromise.then((unlisten) => unlisten())
      void unlistenExitPromise.then((unlisten) => unlisten())
      void unlistenCwdPromise.then((unlisten) => unlisten())
      void unlistenBranchPromise.then((unlisten) => unlisten())
    }
  }, [])

  useEffect(() => {
    console.log('[RemoteAccessPanel] ws status', {
      isRunning: wsStatus.isRunning,
      clientCount: wsStatus.clientCount,
      sessionId: wsStatus.sessionId,
      activeProjectId: wsStatus.activeProjectId,
    })
    if (wsStatus.isRunning) {
      console.log(`[RemoteAccessPanel] ${wsStatus.clientCount} Session Active`)
    }
  }, [wsStatus.isRunning, wsStatus.clientCount, wsStatus.sessionId, wsStatus.activeProjectId])

  const statusLines = [
    `WebSocket server running on port ${WS_PORT}.`,
    authToken ? 'Security token initialized.' : null,
    publicUrl ? 'Cloudflare Tunnel routing established.' : null,
  ].filter((line): line is string => Boolean(line))

  useEffect(() => {
    if (pauseAutoscroll) return
    runtimeStreamRef.current?.scrollTo({ top: runtimeStreamRef.current.scrollHeight, behavior: 'smooth' })
  }, [runtimeStream, pauseAutoscroll])

  const copyRuntimeStream = async (): Promise<void> => {
    const text = runtimeStream.map((line) => line.text).join('\n')
    await navigator.clipboard.writeText(text)
    toast.success('Runtime stream copied')
  }

  const tokenRemaining = useMemo(() => {
    if (!tokenExpiry) return null
    const remaining = tokenExpiry - Math.floor(Date.now() / 1000)
    return remaining > 0 ? remaining : 0
  }, [tokenExpiry])

  const [tokenCountdown, setTokenCountdown] = useState<number | null>(null)

  useEffect(() => {
    if (tokenRemaining !== null) {
      setTokenCountdown(tokenRemaining)
      const interval = setInterval(() => {
        setTokenCountdown((prev) => {
          if (prev === null || prev <= 0) return 0
          return prev - 1
        })
      }, 1000)
      return () => clearInterval(interval)
    }
  }, [tokenRemaining])

  const handleStartWsServer = async () => {
    const token = webLitePassword.trim()
    if (!token.trim()) {
      toast.error('Web Lite Password required')
      return
    }
    useWsServerStore.setState({ authToken: token })
    const result = await startWsServer(WS_PORT, token, useHttps)
    if (result.success) {
      setIsTunnelStarting(true)
      const tunnelConfig = {
        id: TUNNEL_ID,
        name: 'Termul Web',
        localPort: WS_PORT,
        autoStart: false
      }
      const tunnelResult = await startTunnel(tunnelConfig)
      if (tunnelResult && tunnelResult.publicUrl) {
        setIsTunnelStarting(false)
        toast.success('Termul Web ready at ' + tunnelResult.publicUrl)
      } else if (tunnelResult) {
        toast.success('Termul Web started, waiting for tunnel URL...')
      } else {
        setIsTunnelStarting(false)
        toast.error('Tunnel failed: ' + (tunnelError || 'unknown error'))
      }
    } else {
      toast.error(result.error || 'Failed to start server')
    }
  }

  const handleRevokeSession = async () => {
    setIsTunnelStarting(true)
    await rotateToken()
    await stopTunnel(TUNNEL_ID)
    await stopWsServer()
    useWsServerStore.setState({ authToken: null, tokenExpiry: null })
    setWebLitePassword('')
    setAcknowledgeRemoteAccess(false)
    setIsTunnelStarting(false)
    toast.success('Remote session revoked')
  }

  const handleStopWsServer = async () => {
    await stopTunnel(TUNNEL_ID)
    const result = await stopWsServer()
    setAcknowledgeRemoteAccess(false)
    if (result.success) {
      toast.success('Termul Web server stopped')
    } else {
      toast.error(result.error || 'Failed to stop server')
    }
  }

  const handleCopyWsUrl = async () => {
    const url = publicUrl || wsStatus.httpUrl || `http://localhost:${WS_PORT}`
    await navigator.clipboard.writeText(url)
    toast.success('URL copied to clipboard')
  }

  const handleOpenBrowser = async () => {
    const url = publicUrl || wsStatus.httpUrl || `http://localhost:${WS_PORT}`
    window.open(url, '_blank')
  }

  const handleRotateToken = async () => {
    const result = await rotateToken()
    if (result.success) {
      const token = result.token || ''
      setWebLitePassword(token)
      if (token) {
        document.cookie = `termul_web_lite_password=${encodeURIComponent(token)}; Path=/; Max-Age=900; SameSite=Lax`
      }
      toast.success('Token rotated')
    } else {
      toast.error(result.error || 'Failed to rotate token')
    }
  }

  const handleLoadAuditLog = async () => {
    const result = await wsServerApi.getAuditLog()
    if (result.success && result.data) {
      setAuditLog(result.data)
      setShowAuditLog(true)
    } else {
      toast.error(result.error || 'Failed to load audit log')
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6 animate-in fade-in duration-300">
      {/* Header Panel */}
      <div className="relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br from-card to-muted/20 p-6 md:p-8 shadow-sm">
        <div className="absolute top-0 right-0 -mt-6 -mr-6 w-44 h-44 rounded-full bg-primary/5 blur-3xl" />
        <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-center gap-4 md:gap-6">
            <div className="flex items-center justify-center p-4 bg-primary/10 rounded-2xl text-primary ring-1 ring-primary/20 shrink-0">
              <Globe className="h-8 w-8 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold tracking-tight">Termul Web</h1>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-primary/15 text-primary uppercase tracking-wider">
                  v2 Remote
                </span>
              </div>
              <p className="text-sm text-muted-foreground mt-1 max-w-md">
                Access and manage your active terminal instance from any browser, anywhere in the world.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 self-start md:self-auto">
            <div className={cn(
              'px-4 py-2 rounded-2xl text-xs font-semibold uppercase tracking-wider flex items-center gap-2 border shadow-sm transition-all',
              wsStatus.isRunning
                ? 'bg-green-500/10 text-green-500 border-green-500/20'
                : 'bg-muted/50 text-muted-foreground border-border'
            )}>
              <span className="relative flex h-2 w-2">
                {wsStatus.isRunning && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                )}
                <span className={cn('relative inline-flex rounded-full h-2 w-2', wsStatus.isRunning ? 'bg-green-500' : 'bg-muted-foreground/50')} />
              </span>
              {wsStatus.isRunning ? `${wsStatus.clientCount} Session Active` : 'Offline'}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        {/* Connection Control Card */}
        <div className="md:col-span-2 space-y-6">
          <div className="bg-card border rounded-3xl p-6 shadow-sm space-y-5">
            <div className="flex items-center justify-between border-b pb-4">
              <h3 className="font-bold flex items-center gap-2 text-sm uppercase tracking-wider text-muted-foreground">
                <Wifi size={16} className="text-primary" /> Connection Hub
              </h3>
              <div className="flex items-center gap-2">
                <Shield size={14} className="text-muted-foreground" />
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={useHttps}
                    onChange={(e) => setUseHttps(e.target.checked)}
                    className="rounded border-border bg-background text-primary focus:ring-primary/20"
                  />
                  Secure SSL
                </label>
              </div>
            </div>

            {/* Launch Actions */}
            <div className="flex flex-col sm:flex-row gap-3">
              {wsStatus.isRunning ? (
                <>
                  <button
                    onClick={handleOpenBrowser}
                    className="flex-1 py-3 px-4 bg-primary text-primary-foreground rounded-2xl font-semibold flex items-center justify-center gap-2 hover:bg-primary/95 hover:shadow-md transition-all active:scale-[0.98]"
                  >
                    <ExternalLink size={16} /> Open Web UI
                  </button>
                  <button
                    onClick={handleStopWsServer}
                    disabled={wsLoading}
                    className="flex-1 py-3 px-4 bg-destructive/10 text-destructive border border-destructive/20 rounded-2xl font-semibold flex items-center justify-center gap-2 hover:bg-destructive hover:text-destructive-foreground transition-all active:scale-[0.98] disabled:opacity-50"
                  >
                    <WifiOff size={16} /> Disconnect
                  </button>
                </>
              ) : (
                <button
                  onClick={handleStartWsServer}
                  disabled={wsLoading || !acknowledgeRemoteAccess}
                  className="flex-1 py-4 px-6 bg-primary text-primary-foreground rounded-2xl font-semibold flex items-center justify-center gap-2 hover:bg-primary/95 hover:shadow-lg transition-all active:scale-[0.99] disabled:opacity-50"
                >
                  <Zap size={16} /> Start Web Server & Tunnel
                </button>
              )}
            </div>

            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={acknowledgeRemoteAccess}
                  onChange={(e) => setAcknowledgeRemoteAccess(e.target.checked)}
                  className="mt-1 rounded border-border bg-background text-primary focus:ring-primary/20"
                />
                <span className="text-xs leading-relaxed text-foreground/90">
                  I understand remote coding exposes terminal and workspace control to remote clients, is bound to the active project/session, and expires automatically.
                </span>
              </label>
              <div className="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
                <div className="rounded-xl border bg-background/60 px-3 py-2">Project: {activeProject?.name || wsStatus.activeProjectId || 'None'}</div>
                <div className="rounded-xl border bg-background/60 px-3 py-2">Session: {wsStatus.sessionId || 'Pending'}</div>
                <div className="rounded-xl border bg-background/60 px-3 py-2">TTL: {Math.round((wsStatus.tokenTtlSecs || 900) / 60)}m</div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-widest px-1">Web Lite Password</label>
                <input
                  type={showWebLitePassword ? 'text' : 'password'}
                  value={webLitePassword}
                  onChange={(e) => setWebLitePassword(e.target.value)}
                  placeholder="Set password for web lite access"
                  aria-label="Web Lite Password"
                  className="w-full rounded-xl border bg-background/60 px-3 py-2 text-sm outline-none ring-0 focus:border-primary"
                />
                <button
                  type="button"
                  onClick={() => setShowWebLitePassword((value) => !value)}
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {showWebLitePassword ? <EyeOff size={12} /> : <Eye size={12} />}
                  {showWebLitePassword ? 'Hide' : 'Show'} password
                </button>
                <p className="text-[11px] text-muted-foreground px-1">Same password used for `webdev` / remote browser access.</p>
              </div>
            </div>

            {/* Connection Information */}
            {wsStatus.isRunning && (
              <div className="space-y-4 pt-2 border-t animate-in fade-in duration-200">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-widest px-1">Local Address</label>
                  <div
                    className="flex items-center gap-2 bg-muted/50 hover:bg-muted border border-border p-3 rounded-2xl cursor-pointer group transition-colors"
                    onClick={handleCopyWsUrl}
                    title="Click to copy"
                  >
                    <code className="text-xs text-muted-foreground font-mono truncate flex-1">
                      {wsStatus.httpUrl || `http://localhost:${WS_PORT}`}
                    </code>
                    <button
                      className="flex items-center gap-1 px-2.5 py-1 bg-background group-hover:bg-primary group-hover:text-primary-foreground rounded-xl border text-[11px] font-medium transition-colors shrink-0"
                      onClick={(e) => { e.stopPropagation(); handleCopyWsUrl() }}
                    >
                      <Copy size={11} /> Copy
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-widest px-1 flex items-center gap-1.5">
                    <Link size={12} className="text-green-500" /> Cloudflare Public Tunnel
                  </label>
                  {publicUrl ? (
                    <div
                      className="flex items-center gap-2 bg-green-500/5 hover:bg-green-500/10 border border-green-500/20 p-3 rounded-2xl cursor-pointer group transition-colors"
                      onClick={async () => {
                        await navigator.clipboard.writeText(publicUrl)
                        toast.success('Public URL copied')
                      }}
                      title="Click to copy"
                    >
                      <code className="text-xs text-green-600 font-mono truncate flex-1">{publicUrl}</code>
                      <button
                        className="flex items-center gap-1 px-2.5 py-1 bg-green-500/10 text-green-600 group-hover:bg-green-600 group-hover:text-white rounded-xl text-[11px] font-medium transition-all shrink-0"
                        onClick={async (e) => {
                          e.stopPropagation()
                          await navigator.clipboard.writeText(publicUrl)
                          toast.success('Public URL copied')
                        }}
                      >
                        <Copy size={11} /> Copy
                      </button>
                    </div>
                  ) : isTunnelStarting ? (
                    <div className="flex items-center gap-3 bg-muted/40 p-4 rounded-2xl border border-dashed">
                      <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin shrink-0" />
                      <span className="text-xs text-muted-foreground">Provisioning secure endpoint...</span>
                    </div>
                  ) : (
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 bg-destructive/5 border border-destructive/15 p-4 rounded-2xl">
                      <span className="text-xs text-destructive flex-1 leading-normal">
                        {tunnelError || 'No public tunnel active. Termul is only accessible locally.'}
                      </span>
                      <button
                        onClick={async () => {
                          setIsTunnelStarting(true)
                          useTunnelStore.getState().setError(null)
                          const tunnelConfig = {
                            id: TUNNEL_ID,
                            name: 'Termul Web',
                            localPort: WS_PORT,
                            autoStart: false
                          }
                          const tunnelResult = await startTunnel(tunnelConfig)
                          if (tunnelResult && tunnelResult.publicUrl) {
                            setIsTunnelStarting(false)
                            toast.success('Tunnel ready at ' + tunnelResult.publicUrl)
                          } else if (!tunnelResult) {
                            setIsTunnelStarting(false)
                          }
                        }}
                        disabled={isTunnelStarting}
                        className="px-4 py-2 text-xs bg-destructive text-destructive-foreground font-semibold rounded-xl hover:bg-destructive/90 transition-colors disabled:opacity-50 shrink-0"
                      >
                        {isTunnelStarting ? 'Provisioning...' : 'Provision Tunnel'}
                      </button>
                    </div>
                  )}
                  <button
                    onClick={handleRevokeSession}
                    disabled={wsLoading}
                    className="w-full py-2.5 text-xs bg-destructive/10 hover:bg-destructive/15 border border-destructive/20 text-destructive font-semibold rounded-xl transition-all disabled:opacity-50"
                  >
                    Revoke Session
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Security & Token Panel */}
        <div className="space-y-6">
          <div className="bg-card border rounded-3xl p-6 shadow-sm space-y-4">
            <h3 className="font-bold flex items-center gap-2 text-sm uppercase tracking-wider text-muted-foreground border-b pb-3">
              <Shield size={16} className="text-primary" /> Key Access
            </h3>

            {wsStatus.isRunning ? (
              <div className="space-y-3 animate-in fade-in duration-300">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest px-0.5">Authorization Token</label>
                  <div className="flex items-center gap-2 bg-muted/50 p-2.5 rounded-xl border">
                    <code className="text-xs font-mono text-muted-foreground truncate flex-1">
                      {authToken ? `${authToken.slice(0, 12)}...` : 'N/A'}
                    </code>
                    <button
                      className="p-1.5 hover:bg-background rounded-lg border text-muted-foreground hover:text-primary transition-colors shrink-0"
                      onClick={async () => {
                        if (authToken) {
                          await navigator.clipboard.writeText(authToken)
                          toast.success('Token copied')
                        }
                      }}
                      title="Copy token"
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                </div>

                {tokenCountdown !== null && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[10px] font-bold text-muted-foreground uppercase tracking-widest px-0.5">
                      <span>Expires In</span>
                      <span className="text-primary font-mono">{Math.floor(tokenCountdown / 60)}m {tokenCountdown % 60}s</span>
                    </div>
                    <button
                      className="w-full py-2 text-xs bg-muted hover:bg-background border rounded-xl font-medium transition-colors flex items-center justify-center gap-2 text-muted-foreground hover:text-foreground"
                      onClick={handleRotateToken}
                    >
                      <RefreshCw size={12} /> Rotate Token
                    </button>
                  </div>
                )}

                <div className="pt-2">
                  <button
                    className="w-full py-2.5 text-xs bg-primary/5 hover:bg-primary/10 border border-primary/10 hover:border-primary/20 text-primary font-semibold rounded-xl transition-all flex items-center justify-center gap-2"
                    onClick={handleLoadAuditLog}
                  >
                    <Activity size={12} /> View Connection Audits ({auditLog.length})
                  </button>
                </div>
              </div>
            ) : (
              <div className="py-8 text-center space-y-2">
                <Layers className="h-8 w-8 text-muted-foreground/30 mx-auto" />
                <p className="text-xs text-muted-foreground">Server is offline. Start the web server to generate authentication keys.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Audit Log Panel */}
      {showAuditLog && (
        <div className="bg-card border rounded-3xl p-6 shadow-sm space-y-4 animate-in slide-in-from-bottom-2 duration-300">
          <div className="flex items-center justify-between border-b pb-3">
            <h3 className="font-bold flex items-center gap-2 text-sm uppercase tracking-wider text-muted-foreground">
              <FileText size={16} className="text-primary" /> Active Connection Audit Log
            </h3>
            <button
              className="text-xs font-semibold text-muted-foreground hover:text-foreground px-2 py-1 bg-muted rounded-lg"
              onClick={() => setShowAuditLog(false)}
            >
              Dismiss
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto font-mono text-[11px] space-y-1.5 pr-2">
            {auditLog.length > 0 ? (
              [...auditLog].reverse().map((entry, i) => (
                <div key={i} className="flex items-start md:items-center flex-col md:flex-row gap-2 md:gap-4 p-2.5 rounded-xl bg-muted/30 border border-border/50">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] bg-background border px-2 py-0.5 rounded font-bold text-muted-foreground">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </span>
                    <span className={cn(
                      'px-2 py-0.5 rounded-lg text-[9px] font-bold uppercase tracking-wider',
                      entry.event === 'authenticated' ? 'bg-green-500/10 text-green-500 border border-green-500/20' :
                      entry.event === 'auth_failed' ? 'bg-destructive/10 text-destructive border border-destructive/20' :
                      entry.event === 'disconnected' ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20' :
                      'bg-primary/10 text-primary border border-primary/20'
                    )}>
                      {entry.event}
                    </span>
                  </div>
                  <span className="text-muted-foreground truncate flex-1 font-mono">{entry.remoteAddr}</span>
                </div>
              ))
            ) : (
              <div className="py-8 text-center text-xs text-muted-foreground italic">No audit records captured yet.</div>
            )}
          </div>
        </div>
      )}

      {/* Terminal logs shell */}
      <div className="bg-black border border-white/10 rounded-3xl overflow-hidden shadow-xl">
        <div className="px-5 py-3.5 border-b border-white/10 flex items-center justify-between bg-zinc-950">
          <div className="flex items-center gap-2 text-white/50 text-[10px] font-bold uppercase tracking-wider">
            <Terminal size={12} className="text-primary" /> Live Runtime Stream
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPauseAutoscroll((prev) => !prev)}
              className={cn(
                'px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider border rounded-lg',
                pauseAutoscroll
                  ? 'text-amber-300 bg-amber-500/10 border-amber-500/20 hover:bg-amber-500/15'
                  : 'text-zinc-400 bg-white/5 border-white/10 hover:text-white hover:bg-white/10'
              )}
            >
              {pauseAutoscroll ? 'Resume' : 'Pause'}
            </button>
            <button
              onClick={() => void copyRuntimeStream()}
              className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 bg-white/5 border border-white/10 rounded-lg hover:text-white hover:bg-white/10"
            >
              Copy
            </button>
            <button
              onClick={() => setRuntimeStream([])}
              className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 bg-white/5 border border-white/10 rounded-lg hover:text-white hover:bg-white/10"
            >
              Clear
            </button>
            <div className="flex gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-white/10" />
              <span className="w-2.5 h-2.5 rounded-full bg-white/10" />
              <span className="w-2.5 h-2.5 rounded-full bg-white/10" />
            </div>
          </div>
        </div>
          <div ref={runtimeStreamRef} className="h-56 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed bg-black text-green-500/90 selection:bg-white/10">
            {wsStatus.isRunning ? (
              <div className="space-y-1">
              {statusLines.map((line) => (
                <div key={line} className="flex items-center gap-2 text-zinc-400">
                  <span className="text-white/20">[{new Date().toLocaleTimeString()}]</span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded border border-sky-500/20 bg-sky-500/10 text-sky-400 uppercase tracking-wider">system</span>
                  {line}
                </div>
              ))}
              {runtimeStream.length > 0 ? (
                runtimeStream.map((line, index) => (
                  <div
                    key={`${index}-${line.text}`}
                    className="flex items-center gap-2"
                  >
                    <span className="text-white/20">[{new Date().toLocaleTimeString()}]</span>
                    <span
                      className={cn(
                        'text-[9px] px-1.5 py-0.5 rounded border uppercase tracking-wider shrink-0',
                        line.type === 'data' && 'bg-green-500/10 text-green-400 border-green-500/20',
                        line.type === 'exit' && 'bg-red-500/10 text-red-400 border-red-500/20',
                        line.type === 'cwd' && 'bg-amber-500/10 text-amber-300 border-amber-500/20',
                        line.type === 'git' && 'bg-cyan-500/10 text-cyan-300 border-cyan-500/20',
                      )}
                    >
                      {line.type}
                    </span>
                    <div
                      className={cn(
                        'whitespace-pre-wrap break-words flex-1',
                        line.type === 'data' && 'text-green-400',
                        line.type === 'exit' && 'text-red-400',
                        line.type === 'cwd' && 'text-amber-300',
                        line.type === 'git' && 'text-cyan-300',
                      )}
                    >
                      {line.text}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-white/30 animate-pulse">Waiting for runtime output...</div>
              )}
              </div>
            ) : (
            <div className="h-full flex items-center justify-center text-zinc-600 italic">
              Runtime stream is inactive. Start connection to hook into terminal processes.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


