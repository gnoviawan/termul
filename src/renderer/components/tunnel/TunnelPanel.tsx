import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Copy, Play, Square } from 'lucide-react'
import { toast } from 'sonner'
import { tunnelApi } from '@/lib/api'
import { useProjectStore } from '@/stores/project-store'
import { useTunnelStore } from '@/stores/tunnel-store'
import type { TunnelConfig } from '@shared/types/ipc.types'
import { TunnelConfigForm } from './TunnelConfigForm'

function getTunnelErrorHelp(message: string): string {
  const normalized = message.toLowerCase()
  if (normalized.includes('cloudflared is not installed')) {
    return 'Install cloudflared and make sure it is available on PATH.'
  }
  if (normalized.includes('already running')) {
    return 'Stop the existing tunnel first, or use a different tunnel preset id.'
  }
  if (normalized.includes('local port is already in use')) {
    return 'Choose another port or stop the app currently using that port.'
  }
  if (normalized.includes('authentication failed') || normalized.includes('invalid token')) {
    return 'Check your Cloudflare token / login and try again.'
  }
  if (normalized.includes('permission denied')) {
    return 'Run Termul with enough permissions or check your security software.'
  }
  if (normalized.includes('dns resolution failed')) {
    return 'Check your internet connection and DNS settings.'
  }
  return 'Open the logs below for more detail.'
}

export function TunnelPanel(): React.JSX.Element {
  const sessions = useTunnelStore((state) => state.sessions)
  const logs = useTunnelStore((state) => state.logs)
  const isLoading = useTunnelStore((state) => state.isLoading)
  const error = useTunnelStore((state) => state.error)
  const startTunnel = useTunnelStore((state) => state.startTunnel)
  const stopTunnel = useTunnelStore((state) => state.stopTunnel)
  const setError = useTunnelStore((state) => state.setError)
  const upsertSession = useTunnelStore((state) => state.upsertSession)
  const appendLog = useTunnelStore((state) => state.appendLog)

  const activeProject = useProjectStore((state) => state.projects.find((project) => project.id === state.activeProjectId))

  const [localPort, setLocalPort] = useState(activeProject?.tunnelPresets?.[0]?.localPort.toString() ?? '3000')
  const [name, setName] = useState(activeProject?.tunnelPresets?.[0]?.name ?? 'Cloudflare Tunnel')
  const [hostname, setHostname] = useState(activeProject?.tunnelPresets?.[0]?.hostname ?? '')
  const [token, setToken] = useState(activeProject?.tunnelPresets?.[0]?.cloudflareToken ?? '')
  const [showAdvanced, setShowAdvanced] = useState(false)

  useEffect(() => {
    const unsubStatus = tunnelApi.onStatusChanged((event) => {
      upsertSession({ id: event.tunnelId, configId: event.tunnelId, status: event.status, publicUrl: event.publicUrl ?? null, lastError: event.lastError ?? null })
    })
    const unsubLog = tunnelApi.onLog((event) => appendLog(event.tunnelId, event.line))
    void useTunnelStore.getState().refreshSessions()
    return () => { unsubStatus(); unsubLog() }
  }, [appendLog, upsertSession])

  useEffect(() => {
    const preset = activeProject?.tunnelPresets?.[0]
    if (preset) {
      setLocalPort(String(preset.localPort))
      setName(preset.name)
      setHostname(preset.hostname ?? '')
      setToken(preset.cloudflareToken ?? '')
    }
  }, [activeProject?.id, activeProject?.tunnelPresets])

  const activeSession = useMemo(() =>
    sessions.find((session) => session.status === 'running' || session.status === 'starting') ?? null,
    [sessions]
  )

  const handleStart = useCallback(async () => {
    const parsedPort = Number.parseInt(localPort, 10)
    if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
      setError('Invalid port')
      return
    }
    const config: TunnelConfig = {
      id: `tunnel-${Date.now()}`,
      name,
      localPort: parsedPort,
      hostname: hostname || undefined,
      cloudflareToken: token || undefined,
      projectId: activeProject?.id,
      autoStart: false
    }
    const session = await startTunnel(config)
    if (session) toast.success('Tunnel started')
    else toast.error('Failed to start tunnel')

    if (activeProject) {
      const presets = activeProject.tunnelPresets ?? []
      const updated = presets.some((preset) => preset.localPort === parsedPort)
        ? presets.map((preset) => (preset.localPort === parsedPort ? { ...preset, name, hostname, cloudflareToken: token } : preset))
        : [...presets, config]
      useProjectStore.getState().updateProject(activeProject.id, { tunnelPresets: updated })
    }
  }, [activeProject, localPort, name, hostname, token, setError, startTunnel])

  const handleStop = useCallback(async () => {
    if (!activeSession) return
    const ok = await stopTunnel(activeSession.id)
    if (ok) toast.success('Tunnel stopped')
    else toast.error('Failed to stop tunnel')
  }, [activeSession, stopTunnel])

  const copyUrl = useCallback(async () => {
    if (!activeSession?.publicUrl) return
    await navigator.clipboard.writeText(activeSession.publicUrl)
    toast.success('URL copied')
  }, [activeSession])

  const sessionLogs = useMemo(
    () => activeSession ? logs.filter((log) => log.tunnelId === activeSession.id) : [],
    [logs, activeSession]
  )

  return (
    <div className="rounded-lg border border-border bg-background p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Cloudflare Tunnel</h3>
          <p className="text-xs text-muted-foreground">Expose local app via cloudflared</p>
        </div>
        <div className="text-xs text-muted-foreground">{isLoading ? 'processing' : activeSession?.status ?? 'idle'}</div>
      </div>

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_auto]">
        <input
          className="rounded border px-3 py-2 text-sm disabled:bg-muted"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tunnel name"
          disabled={!!activeSession}
        />
        <input
          className="rounded border px-3 py-2 text-sm disabled:bg-muted"
          value={localPort}
          onChange={(e) => setLocalPort(e.target.value)}
          placeholder="Local port"
          inputMode="numeric"
          disabled={!!activeSession}
        />
        <div className="flex gap-2 flex-wrap">
          <button
            className="inline-flex items-center gap-2 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            onClick={handleStart}
            disabled={isLoading || !!activeSession}
          >
            <Play className="h-4 w-4" /> Start
          </button>
          <button
            className="inline-flex items-center gap-2 rounded border px-3 py-2 text-sm disabled:opacity-50"
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? 'Simple' : 'Advanced'}
          </button>
          <button
            className="inline-flex items-center gap-2 rounded border px-3 py-2 text-sm disabled:opacity-50"
            onClick={handleStop}
            disabled={isLoading || !activeSession}
          >
            <Square className="h-4 w-4" /> Stop
          </button>
        </div>
      </div>

      {showAdvanced && (
        <div className="p-3 bg-muted/20 rounded-md border border-dashed animate-in fade-in slide-in-from-top-2">
          <TunnelConfigForm
            name={name}
            localPort={localPort}
            hostname={hostname}
            token={token}
            disabled={!!activeSession}
            showAdvanced={false}
            onNameChange={setName}
            onPortChange={setLocalPort}
            onHostnameChange={setHostname}
            onTokenChange={setToken}
            onToggleAdvanced={() => {}}
          />
        </div>
      )}

      {activeSession?.publicUrl ? (
        <div className="flex items-center justify-between rounded border px-3 py-2 text-sm">
          <span className="truncate">{activeSession.publicUrl}</span>
          <button className="inline-flex items-center gap-2 text-xs" onClick={copyUrl}><Copy className="h-3.5 w-3.5" /> Copy</button>
        </div>
      ) : null}

      {activeProject?.tunnelPresets?.length ? (
        <div className="flex flex-wrap gap-2">
          {activeProject.tunnelPresets.map((preset) => (
            <button
              key={preset.id}
              className="rounded-full border px-3 py-1 text-xs hover:bg-secondary"
              onClick={() => {
                setLocalPort(String(preset.localPort))
                setName(preset.name)
              }}
            >
              {preset.name} · {preset.localPort}
            </button>
          ))}
        </div>
      ) : null}

      {activeSession ? (
        <div className="rounded border bg-muted/30 p-3 text-xs space-y-2">
          <div className="font-medium text-foreground">Live logs</div>
          <div className="max-h-44 overflow-auto rounded bg-background p-2 font-mono text-[11px] leading-5 text-muted-foreground">
            {sessionLogs.length > 0 ? (
              sessionLogs.map((log, index) => (
                <div key={`${log.tunnelId}-${log.timestamp}-${index}`} className="whitespace-pre-wrap break-words">
                  {log.line}
                </div>
              ))
            ) : (
              <div>No tunnel logs yet.</div>
            )}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-600">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              <div className="font-medium">Tunnel error</div>
              <div>{error}</div>
              <div className="text-red-600/80">{getTunnelErrorHelp(error)}</div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
