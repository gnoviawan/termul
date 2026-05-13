import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, Square, Globe, Play, Trash2, Settings, List, Info, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { useTunnelStore } from '@/stores/tunnel-store'
import { useProjectStore } from '@/stores/project-store'
import { cn } from '@/lib/utils'
import { openerApi } from '@/lib/api'
import type { TunnelConfig } from '@shared/types/ipc.types'
import { CloudflaredSetupModal } from './CloudflaredSetupModal'

interface TunnelTabContentProps {
  tunnelId: string
  isVisible: boolean
}

export function TunnelTabContent({ tunnelId, isVisible }: TunnelTabContentProps): React.JSX.Element {
  const session = useTunnelStore((state) => state.sessions.find((item) => item.id === tunnelId) ?? null)
  const logs = useTunnelStore((state) => state.logs)
  const stopTunnel = useTunnelStore((state) => state.stopTunnel)
  const startTunnel = useTunnelStore((state) => state.startTunnel)
  const clearLogs = useTunnelStore((state) => state.clearLogs)
  
  const activeProject = useProjectStore((state) => state.projects.find(p => p.id === state.activeProjectId))

  const tunnelLogs = useMemo(
    () => logs.filter((log) => log.tunnelId === tunnelId),
    [logs, tunnelId]
  )

  const [localPort, setLocalPort] = useState('3000')
  const [name, setName] = useState('Cloudflare Tunnel')
  const [hostname, setHostname] = useState('')
  const [token, setToken] = useState('')
  const [isSetupModalOpen, setIsSetupModalOpen] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Sync with project presets if available
  useEffect(() => {
    const preset = activeProject?.tunnelPresets?.[0]
    if (preset) {
      setLocalPort(String(preset.localPort))
      setName(preset.name)
      setHostname(preset.hostname ?? '')
      setToken(preset.cloudflareToken ?? '')
    }
  }, [activeProject?.id, activeProject?.tunnelPresets])

  const statusLabel = useMemo(() => session?.status ?? 'idle', [session?.status])
  const isRunning = session?.status === 'running' || session?.status === 'starting'

  const copyUrl = async (): Promise<void> => {
    if (!session?.publicUrl) return
    await navigator.clipboard.writeText(session.publicUrl)
    toast.success('URL disalin')
  }

  const openInBrowser = async (): Promise<void> => {
    if (!session?.publicUrl) return
    await openerApi.openWithExternalApp(session.publicUrl)
  }

  const handleStart = useCallback(async () => {
    const port = parseInt(localPort, 10)
    if (isNaN(port)) {
      toast.error('Port tidak valid')
      return
    }
    const config: TunnelConfig = {
      id: tunnelId,
      name,
      localPort: port,
      hostname: hostname || undefined,
      cloudflareToken: token || undefined,
      projectId: activeProject?.id,
      autoStart: false
    }
    const result = await startTunnel(config)
    
    if (result === null) {
        const currentError = useTunnelStore.getState().error
        if (currentError?.includes('cloudflared is not installed')) {
            setIsSetupModalOpen(true)
        }
    } else {
        toast.success('Tunnel started')
    }
  }, [tunnelId, name, localPort, hostname, token, activeProject?.id, startTunnel])

  if (!isVisible) return <div className="hidden" />

  return (
    <div className="flex h-full flex-col bg-background overflow-hidden">
      <CloudflaredSetupModal isOpen={isSetupModalOpen} onClose={() => setIsSetupModalOpen(false)} />
      
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2 shrink-0 bg-muted/20">
        <div className="flex items-center gap-3">
          <div className={cn(
            "w-2 h-2 rounded-full",
            session?.status === 'running' ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" : 
            session?.status === 'starting' ? "bg-yellow-500 animate-pulse" :
            session?.status === 'error' ? "bg-red-500" : "bg-muted-foreground/30"
          )} />
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <span>{name}</span>
          </div>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground font-mono uppercase tracking-wider">
            {statusLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {session?.publicUrl && (
            <>
              <button className="h-7 px-3 flex items-center gap-2 rounded border bg-background text-xs hover:bg-secondary transition-colors" onClick={openInBrowser}>
                <ExternalLink className="h-3 w-3" /> Open
              </button>
              <button className="h-7 px-3 flex items-center gap-2 rounded border bg-background text-xs hover:bg-secondary transition-colors" onClick={copyUrl}>
                <Copy className="h-3 w-3" /> Copy URL
              </button>
            </>
          )}
          {isRunning ? (
            <button className="h-7 px-3 flex items-center gap-2 rounded border bg-background text-xs text-red-500 hover:bg-red-50/50 hover:border-red-200 transition-colors" onClick={() => void stopTunnel(tunnelId)}>
              <Square className="h-3 w-3 fill-current" /> Stop
            </button>
          ) : (
            <button className="h-7 px-3 flex items-center gap-2 rounded bg-primary text-xs text-primary-foreground hover:bg-primary/90 transition-colors" onClick={handleStart}>
              <Play className="h-3 w-3 fill-current" /> Start Tunnel
            </button>
          )}
        </div>
      </div>

      {/* Main Content: Left (Settings) | Right (Logs) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Column: Settings */}
        <div className="w-80 border-r flex flex-col bg-muted/5 shrink-0 overflow-y-auto">
          <div className="p-4 space-y-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                <div className="flex items-center gap-2">
                    <Settings size={12} />
                    Configuration
                </div>
                <button 
                  className="p-1 rounded hover:bg-secondary text-muted-foreground transition-colors" 
                  title="Setup Tutorial"
                  onClick={() => setIsSetupModalOpen(true)}
                >
                  <Info size={13} />
                </button>
              </div>
              
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-muted-foreground px-0.5">Tunnel Name</label>
                  <input 
                    className="w-full rounded border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50" 
                    value={name} 
                    onChange={(e) => setName(e.target.value)} 
                    placeholder="e.g. My Awesome App" 
                    disabled={isRunning}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium text-muted-foreground px-0.5">Local Port</label>
                  <input 
                    className="w-full rounded border bg-background px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50" 
                    value={localPort} 
                    onChange={(e) => setLocalPort(e.target.value)} 
                    placeholder="3000" 
                    inputMode="numeric"
                    disabled={isRunning}
                  />
                </div>

                {/* Advanced Toggle */}
                <button 
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-2 text-[11px] font-bold text-primary uppercase tracking-tighter hover:underline"
                >
                  {showAdvanced ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}
                  {showAdvanced ? 'Hide Advanced Options' : 'Show Advanced Options'}
                </button>

                {showAdvanced && (
                  <div className="space-y-4 pt-1 animate-in fade-in slide-in-from-top-1 duration-200">
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium text-muted-foreground px-0.5">Custom Hostname (Optional)</label>
                      <input 
                        className="w-full rounded border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50" 
                        value={hostname} 
                        onChange={(e) => setHostname(e.target.value)} 
                        placeholder="dev.yourdomain.com" 
                        disabled={isRunning}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-[11px] font-medium text-muted-foreground px-0.5">Cloudflare Token (Optional)</label>
                      <input 
                        type="password"
                        className="w-full rounded border bg-background px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50" 
                        value={token} 
                        onChange={(e) => setToken(e.target.value)} 
                        placeholder="eyJh..." 
                        disabled={isRunning}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {activeProject?.tunnelPresets?.length ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  <List size={12} />
                  Project Presets
                </div>
                <div className="flex flex-col gap-1">
                  {activeProject.tunnelPresets.map((preset) => (
                    <button 
                      key={preset.id} 
                      className="text-left px-3 py-2 text-xs rounded hover:bg-secondary border border-transparent hover:border-border transition-all"
                      onClick={() => { 
                        setLocalPort(String(preset.localPort)); 
                        setName(preset.name);
                        setHostname(preset.hostname ?? '');
                        setToken(preset.cloudflareToken ?? '');
                      }}
                    >
                      <div className="font-medium truncate">{preset.name}</div>
                      <div className="text-[10px] text-muted-foreground">Port {preset.localPort}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Right Column: Logs */}
        <div className="flex-1 flex flex-col bg-background min-w-0">
          <div className="flex items-center justify-between px-4 py-2 border-b">
            <div className="text-[11px] font-medium text-muted-foreground">Live Logs</div>
            <button 
              className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-red-500 transition-colors" 
              title="Clear Logs"
              onClick={() => clearLogs(tunnelId)}
            >
              <Trash2 size={13} />
            </button>
          </div>
          <div className="flex-1 overflow-auto p-4 font-mono text-[11px] leading-relaxed bg-terminal-bg text-terminal-fg">
            {tunnelLogs.length ? (
              <div className="flex flex-col-reverse">
                {tunnelLogs.map((log, index) => (
                  <div key={`${log.tunnelId}-${log.timestamp}-${index}`} className="whitespace-pre-wrap break-words opacity-80 hover:opacity-100 py-0.5 border-l border-white/5 pl-3 ml-1">
                    <span className="text-white/20 mr-2 select-none">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                    {log.line}
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground italic opacity-50">
                Waiting for tunnel logs...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
