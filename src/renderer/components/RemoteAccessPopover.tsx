import { AlertCircle, Check, Copy, ExternalLink, Monitor, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { useUpdateAppSetting } from '@/hooks/use-app-settings'
import { toProjectSummaries } from '@/hooks/use-projects-persistence'
import { toPersistedSessionSummaries } from '@/lib/acp-history-persistence'
import { openerApi, remoteServerApi, syncChatHistory, syncProjects } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useRemoteStatus, useRemoteStatusStore } from '@/stores/remote-status-store'
import { REMOTE_BIND_MODE_OPTIONS, type RemoteBindMode } from '@/types/settings'

const statusBarTriggerClass =
  'flex items-center hover:bg-white/10 px-2 py-0.5 rounded cursor-pointer transition-colors'

export function RemoteAccessPopover(): React.JSX.Element {
  const remoteStatus = useRemoteStatus()
  const remoteBindMode = useAppSettingsStore((s) => s.settings.remoteBindMode)
  const updateSetting = useUpdateAppSetting()
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [copiedUrl, setCopiedUrl] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  const isRunning = remoteStatus?.running ?? false
  const url = remoteStatus?.url ?? null

  const handleRemoteToggle = async (enable: boolean): Promise<void> => {
    setRemoteBusy(true)
    setRemoteError(null)
    setOpenError(null)
    try {
      const result = enable
        ? await remoteServerApi.start({ bindMode: remoteBindMode })
        : await remoteServerApi.stop()
      if (result.success) {
        useRemoteStatusStore.getState().setStatus(result.data)
        // Epic-4 bridge: seed the in-memory project registry so the web/remote
        // client sees the desktop's project list immediately (the live-push
        // path in `useProjectsAutoSave` keeps it in sync on later mutations).
        // No env-var values cross the wire — redact-by-omission.
        if (enable) {
          const { projects, activeProjectId } = useProjectStore.getState()
          // Await + inspect: a failed seed leaves the web client without a
          // project list until the next desktop mutation re-syncs — surface it.
          const syncResult = await syncProjects(
            toProjectSummaries(projects, activeProjectId),
            activeProjectId || null
          )
          if (!syncResult.success) {
            toast.error(`Failed to seed remote project list: ${syncResult.error}`)
          }
          // Seed the chat-history cache (index + visible payloads) so the web
          // sidebar shows the desktop's chats immediately (the live-push path in
          // `useAcpHistorySync` + `persistSession` keeps it in sync).
          // Await the session-index load first so the seed is not empty (the
          // app-mount load in `useAcpHistory` may race with server-start).
          await useAcpStore.getState().loadSessionIndex()
          const { sessionIndex, messages } = useAcpStore.getState()
          const payloads: Record<string, unknown> = {}
          for (const entry of sessionIndex) {
            if (entry.id in messages) {
              payloads[entry.id] = { metadata: entry, messages: messages[entry.id] }
            }
          }
          await syncChatHistory(
            toPersistedSessionSummaries(sessionIndex),
            Object.keys(payloads).length > 0 ? payloads : undefined
          )
        }
      } else {
        setRemoteError(result.error)
      }
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : String(error))
    } finally {
      setRemoteBusy(false)
    }
  }

  const handleCopyRemote = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedUrl(true)
      setTimeout(() => setCopiedUrl(false), 1500)
    } catch {
      // Clipboard unavailable; ignore.
    }
  }

  const handleOpenInBrowser = async (): Promise<void> => {
    if (!url) return
    setOpenError(null)
    const result = await openerApi.openUrlWithSystemBrowser(url)
    if (!result.success) {
      const message = result.error ?? 'Failed to open URL in browser'
      setOpenError(message)
      toast.error(message)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={statusBarTriggerClass}
          aria-label="Remote terminal access"
          aria-pressed={isRunning}
        >
          <Monitor size={14} className={cn('mr-0', isRunning ? 'text-green-300' : undefined)} />
          {isRunning && <span className="sr-only">Remote access enabled</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-96 p-4">
        <div className="space-y-4">
          <div>
            <h4 className="font-medium text-sm text-foreground">Remote Agent Access</h4>
            <p className="text-xs text-muted-foreground mt-1">
              Share your live agent sessions with a browser or phone over HTTP + WebSocket.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Listen on
            </label>
            <select
              value={remoteBindMode}
              onChange={(e) => updateSetting('remoteBindMode', e.target.value as RemoteBindMode)}
              disabled={isRunning}
              className="w-full bg-secondary/50 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary focus:border-transparent outline-none transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {REMOTE_BIND_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              {REMOTE_BIND_MODE_OPTIONS.find((o) => o.value === remoteBindMode)?.description}
              {isRunning && <> Stop the server to change the bind address.</>}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-foreground">Enable remote access</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {remoteBindMode === 'all'
                  ? 'Starts a server on 0.0.0.0 (all network interfaces)'
                  : 'Starts a server on 127.0.0.1 (this machine only)'}
              </div>
            </div>
            <Switch
              checked={isRunning}
              disabled={remoteBusy}
              onCheckedChange={(checked) => void handleRemoteToggle(checked)}
              aria-label="Toggle remote terminal access"
            />
          </div>

          {remoteError && (
            <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{remoteError}</span>
            </div>
          )}

          {isRunning && url && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
                <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  Anyone who can reach this address can drive your live agent sessions. There is no
                  auth token yet — full auth + TLS land in a later release.{' '}
                  {remoteStatus?.bindMode === 'all' ? (
                    <>
                      The server listens on <strong>all interfaces</strong>; devices on your LAN can
                      connect using this machine&apos;s IP and the port below. Exposing it on the
                      LAN before auth ships is your explicit decision.
                    </>
                  ) : (
                    <>
                      The server listens on <strong>localhost only</strong>. To reach it from
                      another device, use a tunnel (e.g.{' '}
                      <code className="text-2xs">cloudflared</code>) or switch to &quot;All
                      interfaces&quot; and restart.
                    </>
                  )}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Bind host</div>
                  <div className="text-sm font-mono text-foreground bg-secondary/50 border border-border rounded-md px-3 py-2">
                    {remoteStatus?.bindHost ?? '—'}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Port</div>
                  <div className="text-sm font-mono text-foreground bg-secondary/50 border border-border rounded-md px-3 py-2">
                    {remoteStatus?.port ?? '—'}
                  </div>
                </div>
                <div className="col-span-2">
                  <div className="text-xs text-muted-foreground mb-1">Open on this machine</div>
                  <div className="text-sm font-mono text-foreground bg-secondary/50 border border-border rounded-md px-3 py-2 truncate">
                    {url.replace(/^https?:\/\//, '')}
                  </div>
                </div>
              </div>

              {remoteStatus?.bindMode === 'all' && (
                <p className="text-xs text-muted-foreground">
                  On other devices, open{' '}
                  <span className="font-mono">
                    http://&lt;this-machine-ip&gt;:{remoteStatus.port}
                  </span>{' '}
                  (replace with your LAN IP).
                </p>
              )}

              <div>
                <div className="text-xs text-muted-foreground mb-1">Open in browser</div>
                <div className="flex items-center gap-2">
                  <input
                    readOnly
                    value={url}
                    className="flex-1 min-w-0 text-sm font-mono text-foreground bg-secondary/50 border border-border rounded-md px-3 py-2 outline-none select-all"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    type="button"
                    onClick={() => void handleCopyRemote(url)}
                    className="shrink-0 inline-flex items-center gap-1 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-md px-3 py-2 transition-colors"
                    aria-label="Copy URL"
                  >
                    {copiedUrl ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    {copiedUrl ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => void handleOpenInBrowser()}
                  className="mt-2 w-full inline-flex items-center justify-center gap-2 text-sm bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-2 transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open in browser
                </button>
                {openError && <p className="text-xs text-destructive mt-1">{openError}</p>}
                <p className="text-xs text-muted-foreground mt-1">
                  Open this URL in a browser to follow your live agent sessions. No token required
                  yet.
                </p>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
