import { AlertCircle, Check, Copy, Monitor, ShieldAlert } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { toProjectSummaries } from '@/hooks/use-projects-persistence'
import { toPersistedSessionSummaries } from '@/lib/acp-history-persistence'
import { remoteServerApi, syncChatHistory, syncProjects } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { useRemoteStatus, useRemoteStatusStore } from '@/stores/remote-status-store'

const statusBarTriggerClass =
  'flex items-center hover:bg-white/10 px-2 py-0.5 rounded cursor-pointer transition-colors'

/**
 * StatusBar popover for remote agent access.
 *
 * Enabling starts the in-process localhost web server + a built-in cloudflared
 * quick-tunnel, producing an ephemeral `https://*.trycloudflare.com` URL the
 * phone can reach on any network. That URL is rendered as a QR — scan to open.
 * No bind selector, no URL text row: the QR is the connect UI.
 *
 * Security posture (until Epic 2 ships a real token): cloudflared provides edge
 * TLS; the random ephemeral URL is the only gate. The warning below makes that
 * explicit and tells the user to toggle off to rotate.
 */
export function RemoteAccessPopover(): React.JSX.Element {
  const remoteStatus = useRemoteStatus()
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [copiedUrl, setCopiedUrl] = useState(false)

  const isRunning = remoteStatus?.running ?? false
  // The QR encodes the public tunnel URL only — never the localhost `url`.
  const tunnelUrl = remoteStatus?.tunnelUrl ?? null
  // Track whether a tunnel URL was ever seen this session so the popover can
  // distinguish "Starting tunnel…" (never connected) from "Tunnel
  // disconnected" (was connected, now gone — the 3s status poll cleared it).
  const [sawUrl, setSawUrl] = useState(false)
  useEffect(() => {
    if (tunnelUrl) setSawUrl(true)
    if (!isRunning) setSawUrl(false)
  }, [tunnelUrl, isRunning])

  const handleRemoteToggle = async (enable: boolean): Promise<void> => {
    setRemoteBusy(true)
    setRemoteError(null)
    try {
      const result = enable ? await remoteServerApi.start() : await remoteServerApi.stop()
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
          // sidebar shows the desktop's chats immediately (the live-push path
          // in `useAcpHistorySync` + `persistSession` keeps it in sync).
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
          // Await + inspect (mirrors the projects seed above): a failed seed
          // leaves the web sidebar empty until the live-push path in
          // `useAcpHistorySync` + `persistSession` re-syncs — surface it.
          // Remote access stays enabled; the live-push path recovers.
          const chatResult = await syncChatHistory(
            toPersistedSessionSummaries(sessionIndex),
            Object.keys(payloads).length > 0 ? payloads : undefined
          )
          if (!chatResult.success) {
            toast.error(`Failed to seed remote chat history: ${chatResult.error}`)
          }
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

  const handleCopyLink = async (): Promise<void> => {
    if (!tunnelUrl) return
    try {
      await navigator.clipboard.writeText(tunnelUrl)
      setCopiedUrl(true)
      setTimeout(() => setCopiedUrl(false), 1500)
    } catch {
      // Clipboard unavailable; ignore.
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
      <PopoverContent side="top" align="end" className="w-72 p-4">
        <div className="space-y-3">
          <div>
            <h4 className="font-medium text-sm text-foreground">Remote Agent Access</h4>
            <p className="text-xs text-muted-foreground mt-1">
              Scan the QR to open your live agent sessions on a phone, on any network.
            </p>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-foreground">Enable remote access</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                Starts a local server + a cloudflared tunnel.
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

          {isRunning && tunnelUrl && (
            <div className="space-y-2">
              {/* White pad so the black QR modules are legible in dark themes. */}
              <div className="flex justify-center">
                <div className="rounded-lg bg-white p-2">
                  <QRCodeSVG value={tunnelUrl} size={160} level="M" />
                </div>
              </div>
              <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
                <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  No auth yet — anyone with this link can drive your live agent. The link is random
                  and shown only to you. Toggle off to rotate.
                </span>
              </div>
              <button
                type="button"
                onClick={() => void handleCopyLink()}
                className="w-full inline-flex items-center justify-center gap-2 text-xs bg-secondary hover:bg-secondary/80 border border-border rounded-md px-3 py-1.5 transition-colors"
                aria-label="Copy tunnel link"
              >
                {copiedUrl ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedUrl ? 'Copied' : 'Copy link'}
              </button>
            </div>
          )}

          {isRunning && !tunnelUrl && (
            <div className="flex items-center justify-center text-xs text-muted-foreground py-2">
              {sawUrl ? 'Tunnel disconnected — toggle off and on to retry' : 'Starting tunnel…'}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
