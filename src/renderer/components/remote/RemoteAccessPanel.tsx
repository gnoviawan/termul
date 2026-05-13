import { useEffect, useMemo, useState } from 'react'
import { Smartphone, Globe, Shield, Play, Square, AlertCircle, Terminal, Copy, Eye, EyeOff } from 'lucide-react'
import { QRCodeCanvas } from 'qrcode.react'
import { useRemoteServerStore } from '@/stores/remote-server-store'
import { useTunnelStore } from '@/stores/tunnel-store'
import { useProjectStore } from '@/stores/project-store'
import { remoteServerApi } from '@/lib/remote-server-api'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export function RemoteAccessPanel(): React.JSX.Element {
  const { status, isLoading, isInstalled, logs, checkInstalled, refreshStatus, startServer, stopServer, appendLog } = useRemoteServerStore()
  const tunnelSessions = useTunnelStore((state) => state.sessions)
  const startTunnel = useTunnelStore((state) => state.startTunnel)
  const stopTunnel = useTunnelStore((state) => state.stopTunnel)
  const activeProject = useProjectStore((state) => state.projects.find((p) => p.id === state.activeProjectId))

  const [port, setPort] = useState(8080)
  const [password, setPassword] = useState(activeProject?.remoteCodingPassword ?? '')
  const [showPassword, setShowPassword] = useState(() => {
    return window.localStorage.getItem('termul.remoteCoding.showPassword') === 'true'
  })
  const [autoOpenQr, setAutoOpenQr] = useState(false)
  const [showPasswordWarning, setShowPasswordWarning] = useState(false)

  useEffect(() => {
    void checkInstalled()
    void refreshStatus()
    const unsubPromise = remoteServerApi.onLog((line) => appendLog(line))
    return () => {
      void unsubPromise.then((unsub) => unsub())
    }
  }, [appendLog, checkInstalled, refreshStatus])

  useEffect(() => {
    setPassword(activeProject?.remoteCodingPassword ?? '')
    setShowPasswordWarning(false)
  }, [activeProject?.id, activeProject?.remoteCodingPassword])

  useEffect(() => {
    window.localStorage.setItem('termul.remoteCoding.showPassword', String(showPassword))
  }, [showPassword])

  const activeTunnel = useMemo(
    () => tunnelSessions.find((session) => session.id === 'remote-coding-tunnel') ?? null,
    [tunnelSessions],
  )

  const publicUrl = activeTunnel?.publicUrl ?? null

  useEffect(() => {
    if (status?.isRunning && publicUrl) {
      setAutoOpenQr(true)
      window.setTimeout(() => setAutoOpenQr(false), 4000)
    }
  }, [status?.isRunning, publicUrl])

  const handleStartAll = async () => {
    if (!password.trim()) {
      setShowPasswordWarning(true)
    }
    const result = await startServer(port, password || undefined)

    if (result.success === false) return

    if (activeProject) {
      useProjectStore.getState().updateProject(activeProject.id, { remoteCodingPassword: password || undefined })
    }

    const tunnelConfig = {
      id: 'remote-coding-tunnel',
      name: 'Remote Coding IDE',
      localPort: port,
      autoStart: false,
    }
    const tunnelResult = await startTunnel(tunnelConfig)
    if (!tunnelResult) {
      toast.error('Failed to start tunnel, retrying...')
      await stopServer()
      return
    }
    toast.success('Remote access enabling...')
  }

  const handleStopAll = async () => {
    await stopServer()
    await stopTunnel('remote-coding-tunnel')
    toast.success('Remote access disabled')
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-primary/10 rounded-2xl text-primary">
            <Smartphone size={32} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Remote Coding</h1>
            <p className="text-muted-foreground">Access your workspace from your phone or tablet.</p>
          </div>
        </div>
        <div className={cn(
          'px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest flex items-center gap-2',
          status?.isRunning ? 'bg-green-500/10 text-green-600 border border-green-500/20' : 'bg-muted text-muted-foreground border',
        )}>
          <div className={cn('w-2 h-2 rounded-full', status?.isRunning ? 'bg-green-500 animate-pulse' : 'bg-current')} />
          {status?.isRunning ? 'Remote Active' : 'Offline'}
        </div>
      </div>

      {!isInstalled && isInstalled !== null && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-4 text-amber-800">
          <AlertCircle className="shrink-0" />
          <div className="space-y-2">
            <p className="text-sm font-semibold">code-server not found</p>
            <p className="text-xs opacity-80">Install code-server first:</p>
            <code className="block bg-amber-900/10 p-2 rounded font-mono text-[11px] select-all">npm install -g code-server</code>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        <div className="space-y-6">
          <div className="bg-card border rounded-2xl p-6 space-y-4 shadow-sm">
            <h3 className="font-semibold flex items-center gap-2 text-sm uppercase tracking-wider text-muted-foreground">
              <Shield size={14} /> Security & Port
            </h3>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium px-1">Local Port</label>
                <input
                  type="number"
                  className="w-full bg-muted/50 border rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                  value={port}
                  onChange={(e) => setPort(parseInt(e.target.value, 10) || 8080)}
                  disabled={status?.isRunning}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium px-1">Password (optional)</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="w-full bg-muted/50 border rounded-xl px-4 py-3 pr-24 outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Set a password for code-server"
                    disabled={status?.isRunning}
                  />
                  <div className="absolute inset-y-0 right-0 flex items-center gap-1 pr-2">
                    <button
                      type="button"
                      className="px-2 text-muted-foreground hover:text-foreground"
                      onClick={async () => {
                        if (!password) return
                        await navigator.clipboard.writeText(password)
                        toast.success('Password copied')
                      }}
                      aria-label="Copy password"
                      disabled={!password}
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      type="button"
                      className="px-2 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground select-none pt-1">
                  <input
                    type="checkbox"
                    checked={showPassword}
                    onChange={(e) => setShowPassword(e.target.checked)}
                    className="rounded border-border bg-background"
                  />
                  Show password
                </label>
              </div>
              {showPasswordWarning ? (
                <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20">
                  <p className="text-xs text-amber-700 leading-relaxed">
                    Password is empty. Remote access will run without auth.
                  </p>
                </div>
              ) : (
                <div className="p-4 rounded-xl bg-primary/5 border border-primary/10">
                  <p className="text-xs text-primary/80 leading-relaxed">
                    If password is empty, remote access runs without auth.
                  </p>
                </div>
              )}
            </div>

            <div className="pt-4">
              {status?.isRunning ? (
                <button
                  onClick={handleStopAll}
                  className="w-full py-4 bg-red-500 text-white rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-red-600 transition-all shadow-lg shadow-red-500/20"
                >
                  <Square size={18} fill="currentColor" /> Disable Remote Access
                </button>
              ) : (
                <button
                  onClick={handleStartAll}
                  disabled={isLoading || isInstalled === false}
                  className="w-full py-4 bg-primary text-primary-foreground rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-primary/90 transition-all shadow-lg shadow-primary/20 disabled:opacity-50"
                >
                  <Play size={18} fill="currentColor" /> Enable Remote Access
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className={cn(
            'bg-card border rounded-2xl p-6 h-full flex flex-col justify-center items-center text-center space-y-4 shadow-sm transition-opacity',
            !status?.isRunning && 'opacity-50 pointer-events-none',
          )}>
            {publicUrl ? (
              <>
                <div className={cn("p-4 bg-white rounded-xl border-4 shadow-inner transition-all", autoOpenQr ? "border-primary ring-4 ring-primary/20" : "border-muted") }>
                  <QRCodeCanvas value={publicUrl} size={180} includeMargin />
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-semibold">Scan to Open on HP</p>
                  <div className="flex items-center gap-2 bg-muted p-2 rounded-lg group">
                    <code className="text-[10px] text-muted-foreground truncate max-w-[180px]">{publicUrl}</code>
                    <button
                      className="p-1.5 hover:bg-background rounded text-primary transition-colors"
                      onClick={() => navigator.clipboard.writeText(publicUrl)}
                      title="Copy URL"
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center gap-4 py-8">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center animate-pulse">
                  <Globe className="text-muted-foreground/30" size={32} />
                </div>
                <p className="text-xs text-muted-foreground max-w-[200px]">
                  {status?.isRunning ? 'Creating secure tunnel...' : 'Start remote server to generate link'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

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
          {logs.length > 0 ? (
            logs.map((log, i) => <div key={i} className="mb-0.5">{`> ${log}`}</div>)
          ) : (
            <div className="space-y-3 text-white/20 italic">
              <div>Waiting for logs...</div>
              <button
                type="button"
                className="text-xs not-italic text-primary hover:underline"
                onClick={async () => {
                  await stopServer()
                  await startServer(port, password || undefined)
                  toast.success('Retrying remote access...')
                }}
              >
                Retry remote access
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
