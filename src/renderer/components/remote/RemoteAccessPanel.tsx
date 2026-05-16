import { useEffect, useMemo, useState } from 'react'
import { Globe, Terminal, Copy, Wifi, WifiOff, RefreshCw, Clock, FileText, Link } from 'lucide-react'
import { useWsServerStore } from '@/stores/ws-server-store'
import { useTunnelStore } from '@/stores/tunnel-store'
import { wsServerApi } from '@/lib/ws-server-api'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { ConnectionAudit } from '@/lib/ws-server-api'

const WS_PORT = 9876
const TUNNEL_ID = 'termul-web-tunnel'

export function RemoteAccessPanel(): React.JSX.Element {
  const { status: wsStatus, isLoading: wsLoading, authToken, tokenExpiry, startServer: startWsServer, stopServer: stopWsServer, generateToken, rotateToken, refreshStatus: refreshWsStatus } = useWsServerStore()
  const tunnelSessions = useTunnelStore((state) => state.sessions)
  const startTunnel = useTunnelStore((state) => state.startTunnel)
  const stopTunnel = useTunnelStore((state) => state.stopTunnel)

  const [useHttps, setUseHttps] = useState(false)
  const [auditLog, setAuditLog] = useState<ConnectionAudit[]>([])
  const [showAuditLog, setShowAuditLog] = useState(false)
  const [isTunnelStarting, setIsTunnelStarting] = useState(false)

  const activeTunnel = useMemo(
    () => tunnelSessions.find((s) => s.id === TUNNEL_ID) ?? null,
    [tunnelSessions],
  )

  const publicUrl = activeTunnel?.publicUrl ?? null

  useEffect(() => {
    void refreshWsStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    const token = authToken || await generateToken()
    const result = await startWsServer(WS_PORT, token, useHttps)
    if (result.success) {
      setIsTunnelStarting(true)
      const tunnelConfig = {
        id: TUNNEL_ID,
        name: 'Termul Web',
        localPort: WS_PORT,
        autoStart: false,
      }
      const tunnelResult = await startTunnel(tunnelConfig)
      setIsTunnelStarting(false)
      if (tunnelResult) {
        toast.success('Termul Web server started with public URL')
      } else {
        toast.success('Termul Web server started (tunnel failed, local only)')
      }
    } else {
      toast.error(result.error || 'Failed to start server')
    }
  }

  const handleStopWsServer = async () => {
    await stopTunnel(TUNNEL_ID)
    const result = await stopWsServer()
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
      toast.success('Token rotated')
    } else {
      toast.error(result.error || 'Failed to rotate token')
    }
  }

  const handleLoadAuditLog = async () => {
    const result = await wsServerApi.getAuditLog()
    if (result.success && result.logs) {
      setAuditLog(result.logs)
      setShowAuditLog(true)
    } else {
      toast.error(result.error || 'Failed to load audit log')
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-primary/10 rounded-2xl text-primary">
            <Globe size={32} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Termul Web</h1>
            <p className="text-muted-foreground">Access your terminal from any browser, anywhere.</p>
          </div>
        </div>
        <div className={cn(
          'px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest flex items-center gap-2',
          wsStatus.isRunning ? 'bg-green-500/10 text-green-600 border border-green-500/20' : 'bg-muted text-muted-foreground border',
        )}>
          <div className={cn('w-2 h-2 rounded-full', wsStatus.isRunning ? 'bg-green-500 animate-pulse' : 'bg-current')} />
          {wsStatus.isRunning ? `${wsStatus.clientCount} connected` : 'Offline'}
        </div>
      </div>

      <div className="bg-card border rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold flex items-center gap-2 text-sm uppercase tracking-wider text-muted-foreground">
            <Wifi size={14} /> Termul Web Server
          </h3>
        </div>

        <div className="flex gap-3">
          {wsStatus.isRunning ? (
            <>
              <button
                onClick={handleOpenBrowser}
                className="flex-1 py-3 bg-primary text-primary-foreground rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-primary/90 transition-all"
              >
                <Globe size={16} /> Open in Browser
              </button>
              <button
                onClick={handleStopWsServer}
                disabled={wsLoading}
                className="flex-1 py-3 bg-red-500/10 text-red-600 border border-red-500/20 rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-red-500/20 transition-all disabled:opacity-50"
              >
                <WifiOff size={16} /> Stop
              </button>
            </>
          ) : (
            <button
              onClick={handleStartWsServer}
              disabled={wsLoading}
              className="flex-1 py-3 bg-primary text-primary-foreground rounded-xl font-medium flex items-center justify-center gap-2 hover:bg-primary/90 transition-all disabled:opacity-50"
            >
              <Wifi size={16} /> Start Termul Web Server
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground select-none">
            <input
              type="checkbox"
              checked={useHttps}
              onChange={(e) => setUseHttps(e.target.checked)}
              className="rounded border-border bg-background"
            />
            Use HTTPS (self-signed cert)
          </label>
        </div>

        {wsStatus.isRunning && (
          <div className="space-y-2">
            <label className="text-xs font-medium px-1 text-muted-foreground">Local URL</label>
            <div className="flex items-center gap-2 bg-muted p-3 rounded-xl">
              <code className="text-xs text-muted-foreground truncate flex-1">
                {wsStatus.httpUrl || `http://localhost:${WS_PORT}`}
              </code>
              <button
                className="p-1.5 hover:bg-background rounded text-primary transition-colors shrink-0"
                onClick={handleCopyWsUrl}
                title="Copy URL"
              >
                <Copy size={14} />
              </button>
            </div>

            {publicUrl ? (
              <div className="space-y-1">
                <label className="text-xs font-medium px-1 text-muted-foreground flex items-center gap-1">
                  <Link size={12} /> Public URL
                </label>
                <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 p-3 rounded-xl">
                  <code className="text-xs text-green-600 truncate flex-1">{publicUrl}</code>
                  <button
                    className="p-1.5 hover:bg-green-500/20 rounded text-green-600 transition-colors shrink-0"
                    onClick={async () => {
                      await navigator.clipboard.writeText(publicUrl)
                      toast.success('Public URL copied')
                    }}
                    title="Copy public URL"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              </div>
            ) : isTunnelStarting ? (
              <div className="flex items-center gap-2 bg-muted p-3 rounded-xl">
                <div className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-muted-foreground">Starting public tunnel...</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 p-3 rounded-xl">
                <span className="text-xs text-amber-600">No public tunnel. Server is local-only.</span>
              </div>
            )}

            <div className="flex items-center gap-2 bg-muted p-3 rounded-xl">
              <code className="text-xs text-muted-foreground truncate flex-1">
                Token: {authToken ? `${authToken.slice(0, 16)}...` : 'N/A'}
              </code>
              <button
                className="p-1.5 hover:bg-background rounded text-primary transition-colors shrink-0"
                onClick={async () => {
                  if (authToken) {
                    await navigator.clipboard.writeText(authToken)
                    toast.success('Token copied')
                  }
                }}
                title="Copy token"
              >
                <Copy size={14} />
              </button>
            </div>
            {tokenCountdown !== null && (
              <div className="flex items-center gap-2 bg-muted p-3 rounded-xl">
                <Clock size={14} className="text-muted-foreground" />
                <span className="text-xs text-muted-foreground flex-1">
                  Token expires in {Math.floor(tokenCountdown / 60)}m {tokenCountdown % 60}s
                </span>
                <button
                  className="p-1.5 hover:bg-background rounded text-primary transition-colors shrink-0"
                  onClick={handleRotateToken}
                  title="Rotate token"
                >
                  <RefreshCw size={14} />
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <button
                className="flex-1 py-2 text-xs bg-muted hover:bg-background rounded-lg transition-colors flex items-center justify-center gap-2"
                onClick={handleLoadAuditLog}
              >
                <FileText size={12} /> Audit Log ({auditLog.length})
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Share public URL + token to access from anywhere. Local URL works on same network.
            </p>
          </div>
        )}
      </div>

      {showAuditLog && (
        <div className="bg-card border rounded-2xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold flex items-center gap-2 text-sm uppercase tracking-wider text-muted-foreground">
              <FileText size={14} /> Connection Audit Log
            </h3>
            <button
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowAuditLog(false)}
            >
              Close
            </button>
          </div>
          <div className="h-64 overflow-y-auto font-mono text-[11px] space-y-1">
            {auditLog.length > 0 ? (
              auditLog.map((entry, i) => (
                <div key={i} className="flex items-center gap-3 p-2 rounded bg-muted/50">
                  <span className="text-muted-foreground whitespace-nowrap">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                  <span className={cn(
                    'px-1.5 py-0.5 rounded text-[10px] font-bold',
                    entry.event === 'authenticated' ? 'bg-green-500/20 text-green-600' :
                    entry.event === 'auth_failed' ? 'bg-red-500/20 text-red-600' :
                    entry.event === 'disconnected' ? 'bg-yellow-500/20 text-yellow-600' :
                    'bg-blue-500/20 text-blue-600'
                  )}>{entry.event}</span>
                  <span className="text-muted-foreground truncate">{entry.remoteAddr}</span>
                </div>
              ))
            ) : (
              <div className="text-muted-foreground italic">No audit entries yet</div>
            )}
          </div>
        </div>
      )}

      <div className="bg-black/95 rounded-2xl border border-white/5 overflow-hidden shadow-2xl">
        <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2 text-white/50 text-[10px] font-bold uppercase tracking-widest">
            <Terminal size={12} /> Server Logs
          </div>
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/20" />
            <div className="w-2.5 h-2.5 rounded-full bg-amber-500/20" />
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/20" />
          </div>
        </div>
        <div className="h-48 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed text-green-500/80">
          <div className="space-y-3 text-white/20 italic">
            <div>Termul Web server logs appear here when running.</div>
          </div>
        </div>
      </div>
    </div>
  )
}
