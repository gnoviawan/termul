/**
 * Headless ACP auth dialog (spec-acp-terminal-auth).
 *
 * Shown when the host's browser-open shim captured the URL an agent tried to
 * open during its auth flow (`acp:browser_open_request` → the store's
 * `pendingBrowserOpen[agentId]`). Headless servers can't open a browser, so
 * the user completes the provider login on their own device, then pastes the
 * failed loopback redirect URL their browser lands on back here — the host
 * replays it to the agent's callback listener (`acp_deliver_auth_redirect`,
 * loopback-only + SSRF-guarded server-side). On desktop the same dialog works
 * unchanged: "Open" uses the system browser and the localhost callback can
 * complete natively.
 */

import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { type AgentId, acpApi } from '@/lib/acp-api'
import { openerApi } from '@/lib/api'
import { logFrontendError } from '@/lib/log-api'
import { configIdFromReuseKey, useAcpStore } from '@/stores/acp-store'

/**
 * Client-side mirror of the host's paste-back SSRF guard: http(s) scheme AND
 * a loopback host only (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`).
 * Non-loopback input is rejected before any request is made — the host
 * re-validates authoritatively before fetching.
 */
export function isLoopbackAuthRedirectUrl(raw: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  // WHATWG keeps the brackets in `hostname` for IPv6 literals.
  if (host === '[::1]') return true
  // IPv4 loopback 127.0.0.0/8 — the URL parser already normalized shorthand
  // forms (e.g. `127.1` → `127.0.0.1`), so a dotted-quad check suffices.
  // Out-of-range quads (`127.999.1.1`) parse as hostnames, not IPv4 — reject
  // them explicitly instead of trusting the digit shape.
  const octets = host.split('.')
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
  )
}

export function BrowserAuthDialog({
  agentId,
  agentName,
  url,
  onDismiss
}: {
  agentId: AgentId
  agentName: string
  url: string
  onDismiss: () => void
}): React.JSX.Element {
  const [pastedUrl, setPastedUrl] = useState('')
  const [delivering, setDelivering] = useState(false)

  const handleOpen = (): void => {
    // Desktop: system browser via the opener plugin. Web/remote: the facade
    // branches to `window.open(url, '_blank', 'noopener')` itself.
    void openerApi.openUrlWithSystemBrowser(url).then((result) => {
      if (!result.success) {
        toast.error(result.error ?? 'Could not open the sign-in URL.')
      }
    })
  }

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Sign-in URL copied')
    } catch {
      toast.error('Could not copy the sign-in URL.')
    }
  }

  const handleDeliver = async (): Promise<void> => {
    const trimmed = pastedUrl.trim()
    if (!isLoopbackAuthRedirectUrl(trimmed)) {
      toast.error(
        'Paste the failed localhost address your browser landed on (http://localhost or 127.0.0.1).'
      )
      return
    }
    setDelivering(true)
    try {
      const status = await acpApi.deliverAuthRedirect(agentId, trimmed)
      if (status >= 200 && status < 400) {
        toast.success('Redirect delivered — finishing sign-in.')
        // A delivered redirect means the agent's listener accepted the OAuth
        // callback — the agent IS authenticated. Mark it (so createSession
        // skips its own authenticate) and re-prepare auth-failed chats.
        useAcpStore.getState().completeBrowserAuth(agentId)
        onDismiss()
      } else {
        // The agent's listener answered but rejected the redirect (wrong
        // state, expired flow). Keep the dialog open so the user can retry.
        toast.error(
          `The agent's sign-in listener returned HTTP ${status}. Check the pasted address and try again.`
        )
      }
    } catch (err) {
      // Redacted boundary log: the pasted URL carries OAuth state/code, so
      // record only that the delivery failed — never the URL or raw error.
      void logFrontendError({
        level: 'warn',
        source: 'BrowserAuthDialog.handleDeliver',
        message: 'Auth redirect delivery request failed'
      })
      // Tauri invoke rejects with plain strings — surface whatever came back.
      toast.error(
        err instanceof Error ? err.message : String(err || 'Could not deliver the redirect URL.')
      )
    } finally {
      setDelivering(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss()
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-sm">{`Finish signing in to ${agentName}`}</DialogTitle>
          <DialogDescription>
            {`${agentName} tried to open a sign-in page, but this machine cannot open a browser. Open the link on your own device and sign in, then paste the failed localhost address your browser lands on back here.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
            {url}
          </code>
          <Button type="button" size="sm" variant="outline" onClick={handleOpen}>
            Open
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void handleCopy()}>
            Copy
          </Button>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="acp-auth-redirect-paste"
            className="text-xs font-medium text-foreground/85"
          >
            Paste the redirect address
          </label>
          <Input
            id="acp-auth-redirect-paste"
            value={pastedUrl}
            onChange={(e) => setPastedUrl(e.target.value)}
            placeholder="http://127.0.0.1:PORT/callback?code=…"
            spellCheck={false}
            autoComplete="off"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !delivering) void handleDeliver()
            }}
          />
          <p className="text-xs text-muted-foreground">
            After signing in, your browser fails to load a localhost address — copy it from the
            address bar and paste it here. Only localhost/127.0.0.1 addresses are accepted.
          </p>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button
            type="button"
            disabled={delivering || pastedUrl.trim().length === 0}
            onClick={() => void handleDeliver()}
          >
            {delivering ? 'Delivering…' : 'Complete sign-in'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
/**
 * Global mount point for the headless-auth dialog (spec-acp-terminal-auth).
 * Rendered once by BOTH app roots (TauriApp + App) so a browser-open request
 * is surfaced no matter where the auth was triggered — the launcher, a chat
 * panel, or a warm-pool spawn. Reads `pendingBrowserOpen` + resolves the
 * agent's display name via `configToLiveAgent` → `agentConfigs` (the agents
 * record carries no name).
 */
export function BrowserAuthDialogHost(): React.JSX.Element {
  const pendingBrowserOpen = useAcpStore((s) => s.pendingBrowserOpen)
  const configToLiveAgent = useAcpStore((s) => s.configToLiveAgent)
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const clearPendingBrowserOpen = useAcpStore((s) => s.clearPendingBrowserOpen)

  const agentNames = useMemo(() => {
    const names: Record<string, string> = {}
    for (const [reuseKey, agentId] of Object.entries(configToLiveAgent)) {
      const configId = configIdFromReuseKey(reuseKey)
      const name = agentConfigs.find((c) => c.id === configId)?.name
      if (name) names[agentId] = name
    }
    return names
  }, [configToLiveAgent, agentConfigs])

  return (
    <>
      {Object.entries(pendingBrowserOpen).map(([agentId, url]) => (
        <BrowserAuthDialog
          key={agentId}
          agentId={agentId}
          agentName={agentNames[agentId] ?? 'Agent'}
          url={url}
          onDismiss={() => clearPendingBrowserOpen(agentId)}
        />
      ))}
    </>
  )
}
