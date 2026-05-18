import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, Square, Globe, Play, List } from 'lucide-react'
import { toast } from 'sonner'
import { useTunnelStore } from '@/stores/tunnel-store'
import { useProjectStore } from '@/stores/project-store'
import { cn } from '@/lib/utils'
import { openerApi, tunnelApi } from '@/lib/api'
import type { TunnelConfig } from '@shared/types/ipc.types'
import { CloudflaredSetupModal } from './CloudflaredSetupModal'
import { TunnelConfigForm } from './TunnelConfigForm'
import { TunnelLogViewer } from './TunnelLogViewer'

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
  const appendLog = useTunnelStore((state) => state.appendLog)
  const upsertSession = useTunnelStore((state) => state.upsertSession)

  const activeProject = useProjectStore((state) => state.projects.find(p => p.id === state.activeProjectId))

  useEffect(() => {
    if (!isVisible) return

    const unsubStatus = tunnelApi.onStatusChanged((event) => {
      if (event.tunnelId === tunnelId) {
        upsertSession({
          id: tunnelId,
          configId: tunnelId,
          status: event.status,
          publicUrl: event.publicUrl ?? null,
          lastError: event.lastError ?? null
        })
      }
    })

    const unsubLog = tunnelApi.onLog((event) => {
      if (event.tunnelId === tunnelId) {
        appendLog(tunnelId, event.line)
      }
    })

    return () => {
      unsubStatus()
      unsubLog()
    }
  }, [isVisible, tunnelId, appendLog, upsertSession])

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

  useEffect(() => {
    const preset = activeProject?.tunnelPresets?.[0]
    if (preset) {
      setLocalPort(String(preset.localPort))
      setName(preset.name)
      setHostname(preset.hostname ?? '')
      setToken(preset.cloudflareToken ?? '')
    }
  }, [activeProject?.id, activeProject?.tunnelPresets])

  const isRunning = session?.status === 'running' || session?.status === 'starting'

  const copyUrl = async (): Promise<void> => {
    if (!session?.publicUrl) return
    await navigator.clipboard.writeText(session.publicUrl)
    toast.success('URL copied')
  }

  const openInBrowser = async (): Promise<void> => {
    if (!session?.publicUrl) return
    try {
      const result = await openerApi.openWithExternalApp(session.publicUrl)
      if (!result.success) {
        window.open(session.publicUrl, '_blank')
        toast.error('Failed to open browser, link copied to clipboard')
        await navigator.clipboard.writeText(session.publicUrl)
      }
    } catch {
      window.open(session.publicUrl, '_blank')
    }
  }

  const handleStart = useCallback(async () => {
    const port = parseInt(localPort, 10)
    if (isNaN(port)) {
      toast.error('Invalid port')
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
            'w-2 h-2 rounded-full',
            session?.status === 'running' ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' :
            session?.status === 'starting' ? 'bg-yellow-500 animate-pulse' :
            session?.status === 'error' ? 'bg-red-500' : 'bg-muted-foreground/30'
          )} />
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <span>{name}</span>
          </div>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground font-mono uppercase tracking-wider">
            {session?.status ?? 'idle'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {session?.publicUrl && (
            <>
              <button className="h-7 px-3 flex items-center gap-2 rounded border bg-background text-xs hover:bg-secondary transition-colors" onClick={openInBrowser}>
                Open
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

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Column: Settings */}
        <div className="w-80 border-r flex flex-col bg-muted/5 shrink-0 overflow-y-auto">
          <div className="p-4 space-y-5">
            <TunnelConfigForm
              name={name}
              localPort={localPort}
              hostname={hostname}
              token={token}
              disabled={isRunning}
              showAdvanced={showAdvanced}
              onNameChange={setName}
              onPortChange={setLocalPort}
              onHostnameChange={setHostname}
              onTokenChange={setToken}
              onToggleAdvanced={() => setShowAdvanced(!showAdvanced)}
              onSetupHelp={() => setIsSetupModalOpen(true)}
            />

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
                        setLocalPort(String(preset.localPort))
                        setName(preset.name)
                        setHostname(preset.hostname ?? '')
                        setToken(preset.cloudflareToken ?? '')
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
        <TunnelLogViewer
          logs={tunnelLogs}
          onClear={() => clearLogs(tunnelId)}
          className="flex-1"
        />
      </div>
    </div>
  )
}
